import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeRemote, target } from "./helpers.js";
import { makePlan, checkPlan } from "../src/planner.js";
import {
  activity,
  bind,
  command,
  defineRemote,
  integration,
  page,
  ref,
  resource,
  settings,
  secret,
} from "../src/dsl.js";
import { PendingSetup } from "../src/engine.js";
import { validateConfig } from "../src/compiler.js";
import { hash, merge, project, redact, resolveRefs } from "../src/util.js";
import { validateRequest } from "../src/schema.js";
import type { Config } from "../src/model.js";

test("activity creates a shell, then sequences, then converges without runtime commands", async () => {
  const remote = new FakeRemote();
  const h = remote.harness();
  const config = defineRemote({
    schemaVersion: 1,
    resources: {
      tv: activity({
        name: "TV",
        entities: ["player"],
        on: [command("player", "media_player.on")],
      }),
    },
  });
  let plan = await makePlan(config, target, h.state, h.adapter);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.operations[0]?.action, "create");
  assert.deepEqual(plan.deferred, ["tv"]);
  await h.engine.apply(plan, h.state);
  plan = await makePlan(config, target, h.state, h.adapter);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.operations[0]?.action, "update");
  await h.engine.apply(plan, h.state);
  plan = await makePlan(config, target, h.state, h.adapter);
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(remote.writes.filter((w) => w.method === "POST").length, 1);
  assert.ok(remote.writes.every((w) => !w.path.endsWith("/command")));
});
test("drift blocks writes unless explicitly overwritten", async () => {
  const remote = new FakeRemote();
  remote.data["/cfg/display"] = { brightness: 30 };
  const h = remote.harness();
  // Use an actual schema field from CfgRemoteDevice instead of hypothetical display keys.
  remote.data["/cfg/device"] = { name: "Original" };
  const config = defineRemote({
    schemaVersion: 1,
    resources: { device: settings("device", { name: "Configured" }) },
  });
  await h.engine.apply(
    await makePlan(config, target, h.state, h.adapter),
    h.state,
  );
  remote.data["/cfg/device"] = { name: "UI edit" };
  const conflict = await makePlan(config, target, h.state, h.adapter);
  assert.match(conflict.conflicts.join(), /Drift/);
  await assert.rejects(h.engine.apply(conflict, h.state), /conflicts/);
  const overwrite = await makePlan(config, target, h.state, h.adapter, {
    overwriteDrift: true,
  });
  assert.equal(overwrite.conflicts.length, 0);
  await h.engine.apply(overwrite, h.state);
  assert.equal((remote.data["/cfg/device"] as any).name, "Configured");
});
test("stale plan fails before any writes", async () => {
  const remote = new FakeRemote();
  remote.data["/cfg/device"] = { name: "A" };
  const h = remote.harness();
  const config = defineRemote({
    schemaVersion: 1,
    resources: { name: settings("device", { name: "B" }) },
  });
  const plan = await makePlan(config, target, h.state, h.adapter);
  remote.data["/cfg/device"] = { name: "Concurrent" };
  await assert.rejects(h.engine.apply(plan, h.state), /changed since plan/);
  assert.equal(remote.writes.length, 0);
});
test("tampering with saved plan is rejected", async () => {
  const remote = new FakeRemote();
  const h = remote.harness();
  const plan = await makePlan(
    { schemaVersion: 1, resources: {} },
    target,
    h.state,
    h.adapter,
  );
  plan.target.host = "http://different.test";
  assert.throws(() => checkPlan(plan), /modified/);
});
test("target and firmware mismatch fail planning", async () => {
  const remote = new FakeRemote();
  remote.data["/pub/version"] = { ...target.version, address: "OTHER" };
  const h = remote.harness();
  await assert.rejects(
    makePlan({ schemaVersion: 1, resources: {} }, target, h.state, h.adapter),
    /identity/,
  );
});
test("resource dependencies are deferred until IDs exist", async () => {
  const remote = new FakeRemote();
  const h = remote.harness();
  const config = defineRemote({
    schemaVersion: 1,
    resources: {
      tv: activity({ name: "TV", entities: [] }),
      screen: page(ref("tv"), {
        name: "Controls",
        grid: { width: 4, height: 6 },
        items: [],
      }),
    },
  });
  const plan = await makePlan(config, target, h.state, h.adapter);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.deferred, ["screen"]);
  assert.equal(plan.operations.length, 1);
});
test("integration setup is checkpointed and resumes without another POST", async () => {
  const remote = new FakeRemote();
  const h = remote.harness();
  const config = defineRemote({
    schemaVersion: 1,
    resources: {
      media: integration({
        driver: "test-driver",
        name: "Media",
        setup: { host: "device.local" },
      }),
    },
  });
  const plan = await makePlan(config, target, h.state, h.adapter);
  assert.deepEqual(plan.conflicts, []);
  await assert.rejects(h.engine.apply(plan, h.state), PendingSetup);
  assert.equal(h.getJournal()?.status, "paused");
  assert.equal(h.getSaved().setups.media?.id, "test-driver");
  assert.deepEqual(
    (await makePlan(config, target, h.state, h.adapter)).deferred,
    ["media"],
  );
  remote.setupState = "OK";
  remote.data["/intg/instances"] = [
    {
      integration_id: "new-instance",
      driver_id: "test-driver",
      name: { en: "Media" },
    },
  ];
  remote.data["/intg/instances/new-instance"] = {
    integration_id: "new-instance",
    driver_id: "test-driver",
    name: { en: "Media" },
  };
  await h.engine.resume(h.state);
  assert.equal(h.state.bindings.media?.id, "new-instance");
  assert.equal(remote.writes.length, 1);
  const next = await makePlan(config, target, h.state, h.adapter);
  await h.engine.apply(next, h.state);
  assert.deepEqual(
    (await makePlan(config, target, h.state, h.adapter)).operations,
    [],
  );
});
test("creation timeout remains uncertain and is not retried by engine", async () => {
  const remote = new FakeRemote();
  remote.fail = (m, p) => m === "POST" && p === "/activities";
  const h = remote.harness();
  const config = defineRemote({
    schemaVersion: 1,
    resources: { tv: activity({ name: "TV", entities: [] }) },
  });
  const plan = await makePlan(config, target, h.state, h.adapter);
  await assert.rejects(h.engine.apply(plan, h.state), /uncertain/);
  assert.equal(h.getJournal()?.entries[0]?.status, "intent");
  assert.equal(h.getJournal()?.status, "failed");
  assert.equal(h.state.bindings.tv, undefined);
});
test("existing name is not silently adopted or duplicated", async () => {
  const remote = new FakeRemote();
  remote.data["/activities"] = [{ entity_id: "existing", name: { en: "TV" } }];
  const h = remote.harness();
  const plan = await makePlan(
    defineRemote({
      schemaVersion: 1,
      resources: { tv: activity({ name: "TV", entities: [] }) },
    }),
    target,
    h.state,
    h.adapter,
  );
  assert.match(plan.conflicts.join(), /already exists/);
  assert.equal(remote.writes.length, 0);
});
test("a disappeared managed resource blocks automatic recreation", async () => {
  const remote = new FakeRemote();
  const h = remote.harness();
  const r = activity({ id: "lost", name: "TV", entities: [] });
  h.state.bindings.tv = {
    id: "lost",
    resource: r,
    baseline: { name: { en: "TV" } },
  };
  const plan = await makePlan(
    defineRemote({ schemaVersion: 1, resources: { tv: r } }),
    target,
    h.state,
    h.adapter,
  );
  assert.match(plan.conflicts.join(), /disappeared/);
});
test("unknown references, cycles and inline secrets are rejected offline", () => {
  assert.throws(
    () =>
      validateConfig(
        defineRemote({
          schemaVersion: 1,
          resources: { p: page(ref("missing"), {}) },
        }),
      ),
    /Unknown/,
  );
  assert.throws(
    () =>
      validateConfig(
        defineRemote({
          schemaVersion: 1,
          resources: { a: page(ref("b"), {}), b: page(ref("a"), {}) },
        }),
      ),
    /cycle/,
  );
  assert.throws(
    () =>
      validateConfig(
        defineRemote({
          schemaVersion: 1,
          resources: {
            i: integration({
              name: "x",
              driver: "d",
              setup: { password: "oops" },
            }),
          },
        }),
      ),
    /secret/,
  );
  validateConfig(
    defineRemote({
      schemaVersion: 1,
      resources: {
        i: integration({
          name: "x",
          driver: "d",
          setup: { password: secret("env:PASS") },
        }),
      },
    }),
  );
});
test("widget overlap and out-of-bounds rejected", () => {
  const item = { type: "text", text: "A", location: { x: 0, y: 0 } };
  assert.throws(
    () =>
      validateConfig(
        defineRemote({
          schemaVersion: 1,
          resources: {
            p: page("a", {
              grid: { width: 2, height: 2 },
              items: [item, item],
            }),
          },
        }),
      ),
    /overlapping/,
  );
  assert.throws(
    () =>
      validateConfig(
        defineRemote({
          schemaVersion: 1,
          resources: {
            p: page("a", {
              grid: { width: 2, height: 2 },
              items: [{ ...item, location: { x: 2, y: 0 } }],
            }),
          },
        }),
      ),
    /outside/,
  );
});
test("runtime JSON rejects NaN, cycles and class instances", () => {
  assert.throws(
    () =>
      validateConfig({
        schemaVersion: 1,
        resources: { a: settings("device", { x: NaN }) },
      }),
    /serializable/,
  );
  const x: any = {};
  x.cycle = x;
  assert.throws(
    () =>
      validateConfig({
        schemaVersion: 1,
        resources: { a: settings("device", x) },
      }),
    /serializable/,
  );
});
test("schema validation catches malformed request payloads", () => {
  assert.throws(() => validateRequest("/activities", "POST", {}), /Invalid/);
  validateRequest("/activities", "POST", {
    name: { en: "TV" },
    options: { entity_ids: [] },
  });
});
test("dropping ownership of one field preserves the remote value", async () => {
  const remote = new FakeRemote();
  remote.data["/cfg/device"] = { name: "A", extra: "preserved" };
  const h = remote.harness();
  const initial = defineRemote({
    schemaVersion: 1,
    resources: { device: settings("device", { name: "A" }) },
  });
  await h.engine.apply(
    await makePlan(initial, target, h.state, h.adapter),
    h.state,
  );
  const unown = defineRemote({
    schemaVersion: 1,
    resources: { device: settings("device", {}) },
  });
  await h.engine.apply(
    await makePlan(unown, target, h.state, h.adapter),
    h.state,
  );
  assert.deepEqual(remote.writes, []);
  assert.equal((remote.data["/cfg/device"] as any).name, "A");
});
test("pagination fetches all pages", async () => {
  const remote = new FakeRemote();
  remote.data["/entities"] = Array.from({ length: 205 }, (_, i) => ({
    entity_id: String(i),
  }));
  const h = remote.harness();
  assert.equal((await h.client.list("/entities")).length, 205);
});
test("redaction removes nested credentials", () => {
  assert.deepEqual(redact({ nested: { password: "secret", host: "device" } }), {
    nested: { password: "[REDACTED]", host: "device" },
  });
});
test("references resolve through state without names", () => {
  const h = new FakeRemote().harness();
  h.state.bindings.device = {
    id: "actual-id",
    resource: settings("device", {}),
    baseline: {},
  };
  assert.equal(resolveRefs(ref("device"), h.state), "actual-id");
});
