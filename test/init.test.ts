import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, isPristine } from "../src/init.js";

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

test("--refresh-docs updates pristine docs and protects edited ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uc-init-"));
  try {
    await init(dir, "0.2.1");
    const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
    assert.ok(isPristine(agents));
    // Plain rerun never touches docs.
    const plain = await init(dir, "0.3.0");
    assert.deepEqual(plain.refreshed, []);
    // Pristine CLAUDE.md is refreshed; edited AGENTS.md is kept with a .new copy.
    await writeFile(join(dir, "AGENTS.md"), agents + "\nMy house rule.\n");
    const r = await init(dir, "0.3.0", { refreshDocs: true });
    assert.deepEqual(r.refreshed, ["CLAUDE.md"]);
    assert.deepEqual(r.conflicts, ["AGENTS.md"]);
    assert.match(
      await readFile(join(dir, "AGENTS.md"), "utf8"),
      /My house rule/,
    );
    assert.match(
      await readFile(join(dir, "AGENTS.md.new"), "utf8"),
      /v0\.3\.0/,
    );
    assert.match(await readFile(join(dir, "CLAUDE.md"), "utf8"), /v0\.3\.0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isPristine recognises unmarked output of older releases only when unedited", () => {
  const v020claude =
    "# Remote 3 configuration (uc-config)\n\nRead AGENTS.md in this folder before doing anything. It is the authoritative\nguide for working here: setup steps, editing rules and safety limits.\n\n@AGENTS.md\n";
  assert.equal(isPristine(v020claude), true);
  assert.equal(isPristine(v020claude + "edit\n"), false);
});
