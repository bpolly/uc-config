import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CoreClient, resolveSecrets } from "../src/client.js";
import { curlFetch } from "../src/transport.js";
import { verifyArtifact } from "../src/compiler.js";
import { Adapter } from "../src/adapter.js";
import { emptyState } from "../src/model.js";
import { validateRequest } from "../src/schema.js";
import { saveJson, readJson, withLock } from "../src/util.js";

test("curl transport sends JSON/auth without redirects and preserves binary bytes", async () => {
  const seen: Array<{ url: string; body: string; auth?: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    seen.push({
      url: req.url!,
      body: Buffer.concat(chunks).toString(),
      auth: req.headers.authorization,
    });
    if (req.url === "/api/binary") {
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.from([0, 1, 2, 255]));
      return;
    }
    if (req.url === "/api/redirect") {
      res.writeHead(302, { location: "/api/other" });
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const client = new CoreClient(
      `http://127.0.0.1:${address.port}`,
      "private-key",
      curlFetch,
    );
    await client.request("POST", "/test", { quoted: 'a "quote"\nnext line' });
    assert.equal(seen[0]?.auth, "Bearer private-key");
    assert.deepEqual(JSON.parse(seen[0]!.body), {
      quoted: 'a "quote"\nnext line',
    });
    assert.deepEqual([...(await client.download("/binary"))], [0, 1, 2, 255]);
    await assert.rejects(client.get("/redirect"), /302/);
    assert.ok(!seen.some((x) => x.url === "/api/other"));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
test("API errors do not echo response credentials", async () => {
  const client = new CoreClient(
    "http://test",
    "secret",
    async () =>
      new Response(JSON.stringify({ token: "LEAK-ME" }), { status: 400 }),
  );
  await assert.rejects(
    client.get("/entities"),
    (e) =>
      e instanceof Error &&
      !e.message.includes("LEAK-ME") &&
      e.message.includes("400"),
  );
});
test("secret references survive schema validation and resolve only on demand", async () => {
  validateRequest("/intg/drivers", "POST", {
    driver_url: "ws://test:9090",
    token: { $secret: "env:UC_TEST_SECRET" },
  });
  process.env.UC_TEST_SECRET = "abc";
  try {
    assert.deepEqual(
      await resolveSecrets({ token: { $secret: "env:UC_TEST_SECRET" } }),
      { token: "abc" },
    );
  } finally {
    delete process.env.UC_TEST_SECRET;
  }
  await assert.rejects(
    resolveSecrets({ $secret: "env:UC_TEST_MISSING_SECRET" }),
    /Missing secret/,
  );
});
test("file artifacts are pinned and modified bytes cannot be uploaded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uc-test-"));
  try {
    const file = join(dir, "icon.png");
    const bytes = Buffer.from("original");
    await writeFile(file, bytes);
    const r = {
      kind: "asset" as const,
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      resourceType: "Icon",
      data: {},
    };
    assert.deepEqual(await verifyArtifact(r), bytes);
    await writeFile(file, "changed");
    await assert.rejects(verifyArtifact(r), /changed since compilation/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("asset upload uses content-addressed multipart and verifies remote bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uc-test-"));
  try {
    const file = join(dir, "icon.png");
    const bytes = Buffer.from("fixture-bytes");
    await writeFile(file, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const id = `uc-${digest}.png`;
    let uploaded = false;
    const client = new CoreClient("http://test", "key", async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST") {
        assert.ok(init.body instanceof FormData);
        const blob = init.body.get("file") as File;
        assert.equal(blob.name, id);
        assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
        uploaded = true;
        return new Response(JSON.stringify([{ id, type: "Icon" }]), {
          status: 201,
        });
      }
      if (path.endsWith(id)) return new Response(bytes);
      return new Response(
        JSON.stringify(uploaded ? [{ id, type: "Icon" }] : []),
      );
    });
    const adapter = new Adapter(client);
    const r = {
      kind: "asset" as const,
      file,
      sha256: digest,
      resourceType: "Icon",
      data: {},
    };
    assert.equal(await adapter.upload(r), id);
    assert.deepEqual(
      (await adapter.observe(r, emptyState("x"), "icon")).value,
      { sha256: digest },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("local state writes are atomic and a second writer cannot acquire a lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uc-test-"));
  try {
    const file = join(dir, "state.json");
    await saveJson(file, { a: 1 });
    assert.deepEqual(await readJson(file), { a: 1 });
    await withLock(join(dir, "lock"), async () => {
      await assert.rejects(
        withLock(join(dir, "lock"), async () => {}),
        /locked/,
      );
    });
    await withLock(join(dir, "lock"), async () => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
