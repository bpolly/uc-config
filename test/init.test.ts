import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/init.js";

test("init scaffolds a workspace without overwriting existing files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uc-init-"));
  try {
    await writeFile(join(dir, "AGENTS.md"), "mine\n");
    const first = await init(dir, "1.2.3");
    assert.deepEqual(first.written.sort(), [
      ".gitignore",
      "CLAUDE.md",
      "package.json",
      "tsconfig.json",
    ]);
    assert.match(
      await readFile(join(dir, "CLAUDE.md"), "utf8"),
      /^@AGENTS\.md$/m,
    );
    assert.deepEqual(first.skipped, ["AGENTS.md"]);
    assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), "mine\n");
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["uc-config"], "^1.2.3");
    assert.match(await readFile(join(dir, ".gitignore"), "utf8"), /^\.uc\/$/m);
    const again = await init(dir, "1.2.3");
    assert.equal(again.written.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init adds uc-config to an existing package.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uc-init-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { a: "1" } }),
    );
    const r = await init(dir, "0.2.0");
    assert.equal(r.packageJsonUpdated, true);
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.deepEqual(pkg.dependencies, { a: "1", "uc-config": "^0.2.0" });
    assert.equal(pkg.type, "module");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
