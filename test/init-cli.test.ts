import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeRemote } from "./helpers.js";

const run = (
  workspace: string,
  args: string[],
  env: Record<string, string> = {},
) =>
  new Promise<{ code: number | null; output: string }>((done, reject) => {
    const child = spawn(
      process.execPath,
      [resolve("dist/cli.js"), "--workspace", workspace, ...args],
      {
        env: {
          ...process.env,
          UC_API_KEY: "",
          UC_PIN: "",
          UC_TARGET: "",
          ...env,
        },
      },
    );
    let output = "";
    child.stdout.on("data", (x) => (output += x));
    child.stderr.on("data", (x) => (output += x));
    child.on("error", reject);
    child.on("close", (code) => done({ code, output }));
  });

test("init connects and authenticates with --host and UC_PIN, then is idempotent", async () => {
  const remote = new FakeRemote();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const result = await remote.transport(`http://remote.test${req.url}`, {
      method: req.method,
      body: body || undefined,
    });
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const ws = await mkdtemp(join(tmpdir(), "uc-init-cli-"));
  try {
    const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const first = await run(ws, ["init", "--host", host], { UC_PIN: "1234" });
    assert.equal(first.code, 0, first.output);
    assert.match(first.output, /created CLAUDE\.md/);
    assert.match(first.output, /Connected home/);
    assert.match(first.output, /API key saved/);
    assert.doesNotMatch(first.output, /1234|fixture-api-key/);
    const creds = JSON.parse(
      await readFile(join(ws, ".uc/credentials.json"), "utf8"),
    );
    assert.deepEqual(Object.values(creds), ["fixture-api-key"]);
    const keyWrites = remote.writes.filter((w) => w.path === "/auth/api_keys");
    assert.equal(keyWrites.length, 1);

    const again = await run(ws, ["init"], { UC_PIN: "1234" });
    assert.equal(again.code, 0, again.output);
    assert.match(again.output, /Already connected/);
    assert.match(again.output, /Already authenticated/);
    assert.equal(
      remote.writes.filter((w) => w.path === "/auth/api_keys").length,
      1,
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("init without a terminal or --host only scaffolds files", async () => {
  const ws = await mkdtemp(join(tmpdir(), "uc-init-cli-"));
  try {
    const r = await run(ws, ["init"]);
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /Skipped connecting/);
    await access(join(ws, "AGENTS.md"));
    await assert.rejects(access(join(ws, ".uc")));
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("init reports an unreachable remote and keeps the files", async () => {
  const ws = await mkdtemp(join(tmpdir(), "uc-init-cli-"));
  try {
    const r = await run(ws, ["init", "--host", "http://127.0.0.1:9"]);
    assert.equal(r.code, 1);
    assert.match(r.output, /Could not reach a Remote 3/);
    await access(join(ws, "package.json"));
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
