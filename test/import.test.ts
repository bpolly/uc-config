import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeRemote, target } from "./helpers.js";
import { activity, defineRemote, page, ref } from "../src/dsl.js";
import { importConfig } from "../src/inventory.js";
import { makePlan } from "../src/planner.js";

test("adopted parents and dependent pages can be planned and adopted together without writes", async () => {
  const remote = new FakeRemote();
  const h = remote.harness();
  remote.data["/activities/existing"] = {
    entity_id: "existing",
    name: { en: "TV" },
    options: { entity_ids: [] },
  };
  remote.data["/activities/existing/ui/pages/main"] = {
    page_id: "main",
    name: "Controls",
    grid: { width: 4, height: 6 },
    items: [],
  };
  const config = defineRemote({
    schemaVersion: 1,
    resources: {
      tv: activity({ id: "existing", name: "TV", entities: [] }),
      controls: page(
        ref("tv"),
        { name: "Controls", grid: { width: 4, height: 6 }, items: [] },
        "main",
      ),
    },
  });
  const plan = await makePlan(config, target, h.state, h.adapter);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.deferred, []);
  assert.deepEqual(
    plan.operations.map((o) => o.action),
    ["adopt", "adopt"],
  );
  assert.deepEqual(h.state.bindings, {});
  await h.engine.apply(plan, h.state);
  assert.deepEqual(remote.writes, []);
  assert.deepEqual(
    (await makePlan(config, target, h.state, h.adapter)).operations,
    [],
  );
});

test("import handles disabled voice assistant and includes external remote layouts and device entities", async () => {
  const remote = new FakeRemote();
  const h = remote.harness();
  remote.data["/cfg/voice_control"] = {
    microphone: false,
    voice_assistant: {},
  };
  remote.data["/cfg/profile"] = { admin_pin_set: true };
  remote.data["/intg/instances"] = [
    { integration_id: "intg", driver_id: "driver", name: { en: "Media" } },
  ];
  remote.data["/intg/instances/intg"] = remote.data["/intg/instances"][0];
  remote.data["/intg/drivers"] = [
    {
      driver_id: "driver",
      name: { en: "Media" },
      driver_url: "ws://driver.local:9090",
      token: "PRIVATE",
    },
  ];
  remote.data["/intg/drivers/driver"] = remote.data["/intg/drivers"][0];
  remote.data["/entities"] = [
    {
      entity_id: "lamp",
      entity_type: "light",
      integration_id: "intg",
      name: { en: "Lamp" },
    },
  ];
  remote.data["/entities/lamp"] = remote.data["/entities"][0];
  remote.data["/remotes"] = [
    {
      entity_id: "external",
      name: { en: "External" },
      options: { kind: "EXTERNAL" },
    },
  ];
  remote.data["/remotes/external"] = remote.data["/remotes"][0];
  remote.data["/remotes/external/buttons"] = [];
  remote.data["/remotes/external/ui/pages"] = [
    { page_id: "main", grid: { width: 4, height: 6 }, items: [] },
  ];
  const { config, warnings } = await importConfig(h.client);
  const resources = Object.values(config.resources);
  assert.ok(resources.some((r) => r.kind === "remote" && r.id === "external"));
  assert.ok(resources.some((r) => r.kind === "remotePage" && r.id === "main"));
  assert.ok(
    resources.some(
      (r) => r.kind === "entity" && r.id === "lamp" && r.parent === "intg",
    ),
  );
  assert.ok(resources.some((r) => r.kind === "driver" && r.id === "driver"));
  assert.equal(JSON.stringify(config).includes("PRIVATE"), false);
  assert.deepEqual(
    resources.find((r) => r.kind === "settings" && r.id === "voice_control")
      ?.data,
    { microphone: false },
  );
  assert.equal(
    resources.some((r) => r.kind === "settings" && r.id === "profile"),
    false,
  );
  assert.ok(warnings.some((w) => w.includes("disabled assistant")));
  assert.deepEqual(remote.writes, []);
});
