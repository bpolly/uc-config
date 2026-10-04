import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeRemote, target } from "./helpers.js";
import { makePlan } from "../src/planner.js";
import { rollbackPlan } from "../src/recovery.js";
import {
  activity,
  defineRemote,
  integration,
  page,
  ref,
  resource,
  settings,
} from "../src/dsl.js";
import { PendingSetup } from "../src/engine.js";
import { validateCommandParameters } from "../src/adapter.js";
import { project } from "../src/util.js";

test("rollback restores a changed configuration field and rejects later edits", async () => {
  const remote = new FakeRemote();
  remote.data["/cfg/device"] = { name: "Before" };
  const h = remote.harness();
  const config = defineRemote({
    schemaVersion: 1,
    resources: { device: settings("device", { name: "After" }) },
  });
  await h.engine.apply(
    await makePlan(config, target, h.state, h.adapter),
    h.state,
  );
  const journal = structuredClone(h.getJournal()!);
  let rollback = await rollbackPlan(journal, target, h.state, h.adapter);
  assert.deepEqual(rollback.conflicts, []);
  remote.data["/cfg/device"] = { name: "Another edit" };
  assert.match(
    (await rollbackPlan(journal, target, h.state, h.adapter)).conflicts.join(),
    /changed after apply/,
  );
  remote.data["/cfg/device"] = { name: "After" };
  await h.engine.apply(rollback, h.state);
  assert.equal((remote.data["/cfg/device"] as any).name, "Before");
});
test("rollback refuses to claim pairing or newly created resources can be undone", async () => {
  const remote = new FakeRemote();
  const h = remote.harness();
  const config = defineRemote({
    schemaVersion: 1,
    resources: { tv: activity({ name: "TV", entities: [] }) },
  });
  await h.engine.apply(
    await makePlan(config, target, h.state, h.adapter),
    h.state,
  );
  assert.match(
    (
      await rollbackPlan(h.getJournal()!, target, h.state, h.adapter)
    ).conflicts.join(),
    /no prior image/,
  );
});
test("changing integration setup starts resumable reconfiguration of the same instance", async () => {
  const remote = new FakeRemote();
  const h = remote.harness();
  const old = integration({
    id: "existing",
    driver: "driver",
    name: "Media",
    setup: { host: "old.local" },
  });
  remote.data["/intg/instances/existing"] = {
    integration_id: "existing",
    driver_id: "driver",
    name: { en: "Media" },
  };
  remote.data["/intg/instances"] = [remote.data["/intg/instances/existing"]];
  h.state.bindings.media = {
    id: "existing",
    resource: old,
    baseline: old.data,
  };
  const config = defineRemote({
    schemaVersion: 1,
    resources: {
      media: integration({
        id: "existing",
        driver: "driver",
        name: "Media",
        setup: { host: "new.local" },
      }),
    },
  });
  const plan = await makePlan(config, target, h.state, h.adapter);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.operations[0]?.action, "reconfigure");
  await assert.rejects(h.engine.apply(plan, h.state), PendingSetup);
  assert.equal((remote.writes[0]?.body as any).reconfigure, true);
  assert.equal(h.state.setups.media?.existingId, "existing");
  remote.setupState = "OK";
  await h.engine.resume(h.state);
  assert.equal(h.state.bindings.media?.id, "existing");
});
test("prune is explicit and blocks inbound references", async () => {
  const remote = new FakeRemote();
  const h = remote.harness();
  const r = activity({ id: "tv-id", name: "TV", entities: [] });
  remote.data["/activities/tv-id"] = {
    entity_id: "tv-id",
    name: { en: "TV" },
    options: { entity_ids: [] },
  };
  remote.data["/activities"] = [remote.data["/activities/tv-id"]];
  remote.data["/activity_groups"] = [];
  remote.data["/profiles"] = [{ profile_id: "family", name: "Family" }];
  remote.data["/profiles/family"] = { profile_id: "family", name: "Family" };
  remote.data["/profiles/family/pages"] = [
    { page_id: "home", items: [{ entity_id: "tv-id" }] },
  ];
  remote.data["/profiles/family/groups"] = [];
  h.state.bindings.tv = { id: "tv-id", resource: r, baseline: r.data };
  const config = defineRemote({ schemaVersion: 1, resources: {} });
  assert.match(
    (await makePlan(config, target, h.state, h.adapter)).conflicts.join(),
    /prune/,
  );
  assert.match(
    (
      await makePlan(config, target, h.state, h.adapter, { prune: true })
    ).conflicts.join(),
    /referenced/,
  );
  remote.data["/profiles/family/pages"] = [];
  const plan = await makePlan(config, target, h.state, h.adapter, {
    prune: true,
  });
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.operations[0]?.action, "delete");
  await h.engine.apply(plan, h.state);
  assert.equal(h.state.bindings.tv, undefined);
  assert.equal(remote.data["/activities/tv-id"], undefined);
});
test("API-supplied page widget defaults do not cause perpetual drift", async () => {
  const remote = new FakeRemote();
  const h = remote.harness();
  remote.data["/activities/a/ui/pages/p"] = {
    page_id: "p",
    grid: { width: 4, height: 6 },
    items: [
      {
        type: "text",
        text: "Hello",
        location: { x: 0, y: 0 },
        size: { width: 1, height: 1 },
      },
    ],
  };
  const r = page(
    "a",
    {
      grid: { width: 4, height: 6 },
      items: [{ type: "text", text: "Hello", location: { x: 0, y: 0 } }],
    },
    "p",
  );
  const config = defineRemote({ schemaVersion: 1, resources: { page: r } });
  const plan = await makePlan(config, target, h.state, h.adapter);
  assert.equal(plan.operations[0]?.action, "adopt");
  await h.engine.apply(plan, h.state);
  assert.deepEqual(
    (await makePlan(config, target, h.state, h.adapter)).operations,
    [],
  );
});
test("partial nested updates preserve unmanaged sibling fields", async () => {
  const remote = new FakeRemote();
  const h = remote.harness();
  remote.data["/activities/a"] = {
    entity_id: "a",
    name: { en: "TV" },
    options: {
      prevent_sleep: false,
      ready_check: true,
      extension: "keep",
      included_entities: [],
    },
  };
  const config = defineRemote({
    schemaVersion: 1,
    resources: {
      a: resource("activity", {
        id: "a",
        data: { options: { prevent_sleep: true } },
      }),
    },
  });
  await h.engine.apply(
    await makePlan(config, target, h.state, h.adapter),
    h.state,
  );
  assert.equal((remote.data["/activities/a"] as any).options.extension, "keep");
  assert.equal((remote.data["/activities/a"] as any).options.ready_check, true);
});
test("command parameters must match metadata constraints", () => {
  const metadata = {
    params: [{ param: "volume", type: "number", min: 0, max: 100 }],
  };
  assert.throws(
    () =>
      validateCommandParameters(
        { cmd_id: "volume", params: { volume: 101 } },
        metadata,
        {},
      ),
    /Invalid parameter/,
  );
  assert.throws(
    () => validateCommandParameters({ cmd_id: "volume" }, metadata, {}),
    /Missing parameter/,
  );
  validateCommandParameters(
    { cmd_id: "volume", params: { volume: 50 } },
    metadata,
    {},
  );
  assert.throws(
    () =>
      validateCommandParameters(
        { cmd_id: "volume", params: { unexpected: 50 } },
        metadata,
        {},
      ),
    /Unknown parameter/,
  );
});
