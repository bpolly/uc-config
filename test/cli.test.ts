import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeRemote } from "./helpers.js";

test("compiled CLI connects, compiles, plans, applies, checks convergence and detects live drift", async () => {
  const remote = new FakeRemote();
  remote.data["/cfg/device"] = { name: "Before" };
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const result = await remote.transport(`http://remote.test${req.url}`, {
        method: req.method,
        body: body || undefined,
      });
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      res.writeHead(500);
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const workspace = await mkdtemp(join(tmpdir(), "uc-cli-"));
  const entry = resolve("dist/cli.js");
  const run = (args: string[]) =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [entry, "--workspace", workspace, ...args],
        { env: { ...process.env, UC_API_KEY: "fixture-token" } },
      );
      let output = "";
      child.stdout.on("data", (x) => (output += x));
      child.stderr.on("data", (x) => (output += x));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
  try {
    const port = (server.address() as { port: number }).port;
    const connected = await run([
      "connect",
      "living-room",
      "--host",
      `http://127.0.0.1:${port}`,
    ]);
    assert.equal(connected.code, 0, connected.output);
    await writeFile(
      join(workspace, "remote.config.ts"),
      `import {defineRemote,settings} from ${JSON.stringify(resolve("dist/index.js"))};\nexport default defineRemote({schemaVersion:1,resources:{name:settings('device',{name:'From code'})}});`,
    );
    for (const args of [
      ["compile"],
      ["plan"],
      ["apply", ".uc/plan.json"],
      ["check"],
    ]) {
      if (args[0] === "apply") {
        const refused = await run([...args, "--adopt-only"]);
        assert.equal(refused.code, 1);
        assert.match(refused.output, /not adoption-only/);
        assert.equal(remote.writes.length, 0);
      }
      const result = await run(args);
      assert.equal(result.code, 0, result.output);
    }
    assert.equal((remote.data["/cfg/device"] as any).name, "From code");
    const plan = JSON.parse(
      await readFile(join(workspace, ".uc/plan.json"), "utf8"),
    );
    assert.equal(plan.operations.length, 1);
    remote.data["/cfg/device"] = { name: "Edited in configurator" };
    const drift = await run(["check"]);
    assert.equal(drift.code, 2);
    assert.match(drift.output, /Drift/);
    const unchanged = remote.writes.length;
    const failure = await run(["apply", ".uc/plan.json"]);
    assert.equal(failure.code, 1);
    assert.equal(remote.writes.length, unchanged);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
