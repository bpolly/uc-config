#!/usr/bin/env node
import { Command } from "commander";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CoreClient, resolveSecrets } from "./client.js";
import { Adapter } from "./adapter.js";
import { compile, validateConfig } from "./compiler.js";
import { Engine, PendingSetup, type Journal } from "./engine.js";
import { formatPlan, makePlan } from "./planner.js";
import { inventory, importConfig, generateBindings } from "./inventory.js";
import {
  emptyState,
  type Config,
  type Plan,
  type State,
  type Target,
} from "./model.js";
import { readJson, saveJson, redact, withLock, isObject } from "./util.js";
import { rollbackPlan } from "./recovery.js";
import { validateRequest } from "./schema.js";
import { diagnose, formatDiagnosis } from "./diagnose.js";
const program = new Command()
  .name("uc-config")
  .description(
    "TypeScript configuration and provisioning for Unfolded Circle Remote 3",
  )
  .version("0.1.0")
  .option("--workspace <path>", "project directory", process.cwd());
const defaultTarget = process.env.UC_TARGET ?? "living-room";
const root = () => resolve(program.opts().workspace);
const local = (name: string) => join(root(), ".uc", name);
const targetName = (name: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid target name");
  return name;
};
const targetFile = (name: string) => local(`targets/${targetName(name)}.json`);
const stateFile = (name: string) => local(`state/${targetName(name)}.json`);
const journalFile = (name: string) =>
  local(`journals/${targetName(name)}.json`);
async function load(name: string) {
  const target = await readJson<Target>(targetFile(name));
  let token = process.env[target.tokenEnv];
  if (!token) {
    try {
      token = (
        await readJson<Record<string, string>>(local("credentials.json"))
      )[target.identity];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const client = new CoreClient(target.host, token);
  let state: State;
  try {
    state = await readJson<State>(stateFile(name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    state = emptyState(target.identity);
  }
  const adapter = new Adapter(client);
  const engine = new Engine(adapter, {
    save: (s) => saveJson(stateFile(name), s),
    journal: async (j) => {
      await saveJson(
        local(`journals/history/${targetName(name)}-${j.planDigest}.json`),
        j,
      );
      await saveJson(journalFile(name), j);
    },
  });
  return { target, client, state, adapter, engine };
}
async function hiddenPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error("Use UC_PIN or run auth in an interactive terminal");
  let muted = false;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output: sink,
    terminal: true,
  });
  process.stdout.write(label);
  muted = true;
  try {
    return await rl.question("");
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}
program
  .command("connect <name>")
  .requiredOption("--host <url>")
  .option("--token-env <name>", "API key environment variable", "UC_API_KEY")
  .action(async (name, o) => {
    const client = new CoreClient(o.host);
    const version = await client.version();
    if (version.model !== "UCR3" || typeof version.address !== "string")
      throw new Error("Expected an identifiable Remote 3");
    const target: Target = {
      host: client.base.origin,
      identity: version.address,
      version,
      tokenEnv: o.tokenEnv,
    };
    try {
      const old = await readJson<Target>(targetFile(name));
      if (old.identity !== target.identity)
        throw new Error(
          "Target name already refers to another remote; use a new name",
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await saveJson(targetFile(name), target);
    console.log(
      `Connected ${name}: ${version.model}, core ${version.core}, API ${version.api}. No configuration changed.`,
    );
  });
program
  .command("auth")
  .option("--target <name>", "target", defaultTarget)
  .action(async (o) => {
    const { target } = await load(o.target);
    const pin =
      process.env.UC_PIN ?? (await hiddenPrompt("Web configurator PIN: "));
    const client = new CoreClient(target.host);
    validateRequest("/auth/api_keys", "POST", {
      name: "uc-config",
      scopes: ["admin"],
    });
    const { data } = await client.request(
      "POST",
      "/auth/api_keys",
      { name: "uc-config", scopes: ["admin"] },
      {
        Authorization: `Basic ${Buffer.from(`web-configurator:${pin}`).toString("base64")}`,
      },
    );
    if (typeof data.api_key !== "string")
      throw new Error("No API key returned");
    let credentials: Record<string, string> = {};
    try {
      credentials = await readJson(local("credentials.json"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    credentials[target.identity] = data.api_key;
    await saveJson(local("credentials.json"), credentials);
    console.log(
      "API key saved in .uc/credentials.json (mode 0600, gitignored). Approve it on the remote if requested, then run doctor.",
    );
  });
program
  .command("doctor")
  .option("--target <name>", "target", defaultTarget)
  .action(async (o) => {
    const { client, target } = await load(o.target);
    await client.verifyTarget(target);
    console.log(
      `Identity verified; core ${target.version.core}, reported API ${target.version.api}`,
    );
    for (const path of [
      "/entities",
      "/activities",
      "/intg/drivers",
      "/intg/instances",
      "/intg/setup",
      "/docks",
      "/profiles",
      "/cfg/device/button_layout",
      "/cfg/device/screen_layout",
    ]) {
      try {
        await client.get(path);
        console.log(`OK ${path}`);
      } catch (e) {
        console.log(`FAIL ${(e as Error).message}`);
        process.exitCode = 1;
      }
    }
  });
program
  .command("inventory")
  .option("--target <name>", "target", defaultTarget)
  .option("--out <file>", "JSON output", ".uc/inventory.json")
  .option("--bindings <file>", "TypeScript device bindings")
  .action(async (o) => {
    const { client } = await load(o.target);
    const inv = await inventory(client);
    await saveJson(resolve(root(), o.out), redact(inv));
    if (o.bindings) await saveText(o.bindings, generateBindings(inv));
    console.log(
      `Inventory written to ${o.out}${inv.unsupported.length ? `; ${inv.unsupported.length} unavailable endpoints` : ""}`,
    );
  });
async function saveText(file: string, contents: string) {
  const dest = resolve(root(), file);
  await mkdir(resolve(dest, ".."), { recursive: true });
  await writeFile(dest, contents, { mode: 0o600, flag: "wx" });
}
program
  .command("import")
  .option("--target <name>", "target", defaultTarget)
  .option("--out <file>", "TypeScript output", "remote.config.ts")
  .action(async (o) => {
    const { client } = await load(o.target);
    const { config, warnings } = await importConfig(client);
    validateConfig(config);
    await saveText(
      o.out,
      `import { defineRemote } from 'uc-config';\n\nexport default defineRemote(${JSON.stringify(config, null, 2)});\n`,
    );
    await saveJson(local("import-warnings.json"), warnings);
    console.log(
      `Wrote ${o.out}; no ownership or remote changes.\n${warnings.map((w) => `- ${w}`).join("\n")}`,
    );
  });
program
  .command("compile")
  .description("Compile TypeScript configuration into a local JSON snapshot")
  .option("--config <file>", "TypeScript source", "remote.config.ts")
  .option("--out <file>", "IR output", ".uc/build.json")
  .action(async (o) => {
    const config = await compile(resolve(root(), o.config));
    await saveJson(resolve(root(), o.out), config);
    console.log(
      `Compiled ${Object.keys(config.resources).length} resources to ${o.out}`,
    );
  });
program
  .command("plan")
  .option("--target <name>", "target", defaultTarget)
  .option("--build <file>", "compiled IR", ".uc/build.json")
  .option("--out <file>", "saved plan", ".uc/plan.json")
  .option("--overwrite-drift", "explicitly replace edits to managed fields")
  .option(
    "--prune",
    "delete removed, previously managed resources after checking references",
  )
  .action(async (o) => {
    const { target, state, adapter } = await load(o.target);
    const config = await readJson<Config>(resolve(root(), o.build));
    const plan = await makePlan(config, target, state, adapter, {
      overwriteDrift: !!o.overwriteDrift,
      prune: !!o.prune,
    });
    await saveJson(resolve(root(), o.out), plan);
    console.log(formatPlan(plan));
    if (plan.conflicts.length) process.exitCode = 2;
  });
program
  .command("apply <plan>")
  .option("--target <name>", "target", defaultTarget)
  .option(
    "--adopt-only",
    "record existing configuration locally; refuse any remote mutations",
  )
  .action(async (file, o) => {
    await withLock(local(`locks/${targetName(o.target)}.lock`), async () => {
      const { target, state, engine } = await load(o.target);
      const plan = await readJson<Plan>(resolve(root(), file));
      if (o.adoptOnly && plan.operations.some((op) => op.action !== "adopt"))
        throw new Error("Plan is not adoption-only; no changes made");
      if (
        plan.target.identity !== target.identity ||
        plan.target.host !== target.host
      )
        throw new Error("Plan target differs from selected target");
      try {
        const journal = await readJson<Journal>(journalFile(o.target));
        if (journal.status === "failed" || journal.status === "running")
          throw new Error(
            "Previous apply is unresolved; run resume and inspect journal before applying again",
          );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      console.log(formatPlan(plan));
      await engine.apply(plan, state);
      console.log(
        `Applied and verified. ${plan.deferred.length ? "Replan deferred resources." : "Run check to confirm convergence."}`,
      );
    });
  });
program
  .command("check")
  .option("--target <name>", "target", defaultTarget)
  .option("--build <file>", "compiled IR", ".uc/build.json")
  .action(async (o) => {
    const { target, state, adapter } = await load(o.target);
    const plan = await makePlan(
      await readJson<Config>(resolve(root(), o.build)),
      target,
      state,
      adapter,
    );
    console.log(formatPlan(plan));
    if (plan.operations.length || plan.conflicts.length || plan.deferred.length)
      process.exitCode = 2;
  });
program
  .command("resume")
  .option("--target <name>", "target", defaultTarget)
  .action(async (o) => {
    await withLock(local(`locks/${targetName(o.target)}.lock`), async () => {
      const { target, state, client, engine } = await load(o.target);
      await client.verifyTarget(target);
      console.log(
        (await engine.resume(state)).join("\n") ||
          "No pending setup processes.",
      );
      let journal: Journal;
      try {
        journal = await readJson<Journal>(journalFile(o.target));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          console.log("Compile and plan the next phase.");
          return;
        }
        throw e;
      }
      const uncertain = journal.entries.filter(
        (e) =>
          (e.status === "intent" || e.status === "created") &&
          !state.bindings[e.key] &&
          !state.setups[e.key],
      );
      if (uncertain.length)
        throw new Error(
          `Uncertain writes: ${uncertain.map((e) => e.key).join(", ")}. Inspect inventory and use state adopt with the exact resulting id; no automatic retry.`,
        );
      journal.status = Object.keys(state.setups).length ? "paused" : "complete";
      await saveJson(journalFile(o.target), journal);
      console.log(
        "Saved progress retained. Compile and plan to reconcile remaining configuration.",
      );
    });
  });
const setup = program.command("setup");
setup
  .command("status <key>")
  .option("--target <name>", "target", defaultTarget)
  .action(async (key, o) => {
    const { state, client } = await load(o.target);
    const s = state.setups[key];
    if (!s) throw new Error("No pending setup for this key");
    const info = await client.get(
      `/${s.kind === "integration" ? "intg" : "docks"}/setup/${encodeURIComponent(s.id)}`,
    );
    console.log(JSON.stringify(redact(info), null, 2));
  });
setup
  .command("respond <key>")
  .option("--target <name>", "target", defaultTarget)
  .option("--input <file>", "JSON request body; use secret references")
  .option("--confirm", "confirm requested physical action")
  .action(async (key, o) => {
    await withLock(local(`locks/${targetName(o.target)}.lock`), async () => {
      const { state, client, target } = await load(o.target);
      await client.verifyTarget(target);
      const s = state.setups[key];
      if (!s) throw new Error("No pending setup");
      if (!!o.input === !!o.confirm)
        throw new Error("Provide exactly one of --input or --confirm");
      const body = o.confirm
        ? { confirm: true }
        : await resolveSecrets(await readJson(resolve(root(), o.input)));
      const template =
        s.kind === "integration"
          ? "/intg/setup/{driverId}"
          : "/docks/setup/{dockId}";
      validateRequest(template, "PUT", body);
      await client.request(
        "PUT",
        `/${s.kind === "integration" ? "intg" : "docks"}/setup/${encodeURIComponent(s.id)}`,
        body,
      );
      console.log("Response submitted. Run resume.");
    });
  });
const pair = program.command("pairing");
pair
  .command("status <remoteId>")
  .option("--target <name>", "target", defaultTarget)
  .action(async (id, o) => {
    const { client } = await load(o.target);
    console.log(
      JSON.stringify(
        redact(
          await client.get(`/remotes/${encodeURIComponent(id)}/bt/pairing`),
        ),
        null,
        2,
      ),
    );
  });
pair
  .command("respond <remoteId>")
  .option("--target <name>", "target", defaultTarget)
  .requiredOption(
    "--input <file>",
    "Pairing response JSON; passkey can use secret() JSON reference",
  )
  .action(async (id, o) => {
    const { client, target } = await load(o.target);
    await client.verifyTarget(target);
    const body = await resolveSecrets(await readJson(resolve(root(), o.input)));
    validateRequest("/remotes/{entityId}/bt/pairing", "POST", body);
    await client.request(
      "POST",
      `/remotes/${encodeURIComponent(id)}/bt/pairing`,
      body,
    );
    console.log("Pairing response submitted. Replan to verify pairing.");
  });
const stateCmd = program.command("state");
stateCmd
  .command("adopt <key> <id>")
  .option("--target <name>", "target", defaultTarget)
  .option("--build <file>", "compiled IR", ".uc/build.json")
  .action(async (key, id, o) => {
    await withLock(local(`locks/${targetName(o.target)}.lock`), async () => {
      const { state, adapter, target } = await load(o.target);
      await adapter.client.verifyTarget(target);
      if (state.bindings[key])
        throw new Error("Key already bound; use state move or forget first");
      const config = await readJson<Config>(resolve(root(), o.build));
      const r = config.resources[key];
      if (!r) throw new Error("Unknown configuration key");
      const obs = await adapter.observe({ ...r, id }, state, key);
      if (!obs.value) throw new Error("No such remote resource");
      state.bindings[key] = { id, resource: r, baseline: {} };
      delete state.setups[key];
      state.revision++;
      await saveJson(stateFile(o.target), state);
      console.log(
        "Identity adopted; no remote changes. Resume, then plan field ownership.",
      );
    });
  });
stateCmd
  .command("forget <key>")
  .option("--target <name>", "target", defaultTarget)
  .action(async (key, o) => {
    await withLock(local(`locks/${targetName(o.target)}.lock`), async () => {
      const { state } = await load(o.target);
      if (!state.bindings[key]) throw new Error("Unknown managed key");
      delete state.bindings[key];
      state.revision++;
      await saveJson(stateFile(o.target), state);
      console.log("Ownership removed. Remote resource preserved.");
    });
  });
stateCmd
  .command("move <from> <to>")
  .option("--target <name>", "target", defaultTarget)
  .action(async (from, to, o) => {
    await withLock(local(`locks/${targetName(o.target)}.lock`), async () => {
      const { state } = await load(o.target);
      if (
        !state.bindings[from] ||
        state.bindings[to] ||
        !/^\w[\w.-]*$/.test(to)
      )
        throw new Error("Invalid source/destination key");
      state.bindings[to] = state.bindings[from]!;
      delete state.bindings[from];
      const rewrite = (x: unknown): unknown =>
        Array.isArray(x)
          ? x.map(rewrite)
          : isObject(x)
            ? Object.fromEntries(
                Object.entries(x).map(([k, v]) => [
                  k,
                  k === "$ref" && v === from ? to : rewrite(v),
                ]),
              )
            : x;
      state.bindings = rewrite(state.bindings) as State["bindings"];
      state.revision++;
      await saveJson(stateFile(o.target), state);
      console.log("State key moved; update source references and recompile.");
    });
  });
program
  .command("rollback")
  .option("--target <name>", "target", defaultTarget)
  .option("--journal <file>", "journal to compensate; defaults to latest")
  .option("--out <file>", "rollback plan", ".uc/rollback-plan.json")
  .action(async (o) => {
    const { target, state, adapter } = await load(o.target);
    const journal = await readJson<Journal>(
      o.journal ? resolve(root(), o.journal) : journalFile(o.target),
    );
    const plan = await rollbackPlan(journal, target, state, adapter);
    await saveJson(resolve(root(), o.out), plan);
    console.log(formatPlan(plan));
    console.log(
      "Rollback plan saved; review and apply explicitly. Source must also be reverted to retain the rollback.",
    );
    if (plan.conflicts.length) process.exitCode = 2;
  });
program
  .command("backup")
  .option("--target <name>", "target", defaultTarget)
  .requiredOption("--out <file>", "native backup archive")
  .action(async (o) => {
    await withLock(local(`locks/${targetName(o.target)}.lock`), async () => {
      const { client, target } = await load(o.target);
      await client.verifyTarget(target);
      console.log(
        "Exporting native backup: the remote temporarily stops integrations and docks. Keep the archive private; it may contain credentials.",
      );
      const bytes = await client.download("/system/backup/export");
      const file = resolve(root(), o.out);
      await mkdir(resolve(file, ".."), { recursive: true });
      await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
      console.log(`Backup saved to ${o.out}`);
    });
  });
const ir = program.command("ir");
ir.command("learn <emitterId>")
  .option("--target <name>", "target", defaultTarget)
  .option("--timeout <seconds>", "learning window", "60")
  .action(async (id, o) => {
    const seconds = Number(o.timeout);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300)
      throw new Error("Timeout must be 1–300 seconds");
    const { client, target } = await load(o.target);
    await client.verifyTarget(target);
    await client.request(
      "PUT",
      `/ir/emitters/${encodeURIComponent(id)}/learn?timeout=${seconds}`,
    );
    console.log(
      "Learning started. Press the original remote button, then run ir capture.",
    );
  });
ir.command("capture <emitterId>")
  .option("--target <name>", "target", defaultTarget)
  .requiredOption("--out <file>", "learned code JSON")
  .action(async (id, o) => {
    const { client } = await load(o.target);
    const codes = await client.get(
      `/ir/emitters/${encodeURIComponent(id)}/learn`,
    );
    await saveJson(resolve(root(), o.out), codes);
    console.log(
      "Captured learning status/codes. Assign chosen codes to irCode() resources.",
    );
  });
program
  .command("diagnose")
  .description(
    "Read-only health check: orphaned entity references and disconnected integrations",
  )
  .option("--target <name>", "target", defaultTarget)
  .option("--json", "machine-readable output")
  .action(async (o) => {
    const { client, target } = await load(o.target);
    await client.verifyTarget(target);
    const result = await diagnose(client);
    console.log(
      o.json ? JSON.stringify(result, null, 2) : formatDiagnosis(result),
    );
    if (result.orphans.length || result.problems.length) process.exitCode = 2;
  });
program
  .command("api <method> <path>")
  .description(
    "Raw authenticated Core API request (path relative to /api). Non-GET requires --write.",
  )
  .option("--target <name>", "target", defaultTarget)
  .option("--data <json>", "JSON request body")
  .option("--write", "allow a non-GET request")
  .action(async (method: string, path: string, o) => {
    const verb = method.toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(verb))
      throw new Error(`Unsupported method ${method}`);
    if (verb !== "GET" && !o.write)
      throw new Error(
        `${verb} changes the remote; rerun with --write once intended`,
      );
    const { client, target } = await load(o.target);
    await client.verifyTarget(target);
    const body = o.data === undefined ? undefined : JSON.parse(o.data);
    const { data } = await client.request<unknown>(verb, path, body);
    console.log(JSON.stringify(redact(data), null, 2));
  });
program.parseAsync().catch((e) => {
  console.error(
    e instanceof PendingSetup
      ? `Paused: ${e.message}`
      : `Error: ${(e as Error).message}`,
  );
  process.exitCode = e instanceof PendingSetup ? 3 : 1;
});
