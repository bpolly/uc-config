import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeRemote } from "./helpers.js";

test("backup keeps timestamped archives in backups/, gitignored, and doctor reports them", async () => {
  const remote = new FakeRemote();
  remote.data["/system/backup/export"] = "ARCHIVE";
  for (const p of ["/intg/setup", "/cfg/device/screen_layout"])
    remote.data[p] = [];
  const server = createServer(async (req, res) => {
    const result = await remote.transport(`http://remote.test${req.url}`, {
      method: req.method,
    });
    const headers = Object.fromEntries(result.headers);
    if (req.url?.includes("/system/backup/export"))
      headers["content-disposition"] =
        'attachment; filename="UCR3_backup.tar.gz"';
    res.writeHead(result.status, headers);
    res.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const workspace = await mkdtemp(join(tmpdir(), "uc-backup-"));
  const run = (args: string[]) =>
    new Promise<{ code: number | null; output: string }>((done, reject) => {
      const env = { ...process.env, UC_API_KEY: "fixture-token" };
      delete env.UC_TARGET;
      delete env.UC_PIN;
      env.UC_NO_UPDATE_CHECK = "1";
      const child = spawn(
        process.execPath,
        [resolve("dist/cli.js"), "--workspace", workspace, ...args],
        { env },
      );
      let output = "";
      child.stdout.on("data", (x) => (output += x));
      child.stderr.on("data", (x) => (output += x));
      child.on("error", reject);
      child.on("close", (code) => done({ code, output }));
    });
  try {
    const port = (server.address() as { port: number }).port;
    assert.equal(
      (await run(["connect", "home", "--host", `http://127.0.0.1:${port}`]))
        .code,
      0,
    );
    const empty = await run(["backup", "--list"]);
    assert.match(empty.output, /No full backups/);
    assert.match((await run(["doctor"])).output, /No full backup yet/);

    const first = await run(["backup"]);
    assert.equal(first.code, 0, first.output);
    await new Promise((r) => setTimeout(r, 1100)); // distinct timestamp
    assert.equal((await run(["backup"])).code, 0);

    const files = (await readdir(join(workspace, "backups"))).sort();
    const archives = files.filter((f) => f.endsWith(".tar.gz"));
    assert.equal(archives.length, 2);
    assert.match(archives[0]!, /^ucr3-\d{4}-\d{2}-\d{2}T\d{6}\.tar\.gz$/);
    assert.ok(files.includes(".gitignore"));
    assert.match(
      await readFile(join(workspace, "backups", ".gitignore"), "utf8"),
      /^\*$/m,
    );
    const mode = (await stat(join(workspace, "backups", archives[0]!))).mode;
    assert.equal(mode & 0o077, 0);
    const listed = await run(["backup", "--list"]);
    assert.equal(listed.output.trim().split("\n").length, 2);
    assert.match((await run(["doctor"])).output, /Full backups: 2/);
    assert.equal(
      remote.writes.length,
      0,
      "backup must not write to the remote",
    );
    assert.doesNotMatch(first.output, /fixture-token/);
  } finally {
    server.close();
  }
});
