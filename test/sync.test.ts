import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeRemote, target } from "./helpers.js";
import { importConfig } from "../src/inventory.js";
import { makePlan } from "../src/planner.js";
import {
  parseSource,
  remoteGone,
  renderSource,
  syncConfig,
} from "../src/sync.js";
import type { Config } from "../src/model.js";

function activityOn(remote: FakeRemote, id: string, name: string) {
  const v = {
    entity_id: id,
    name: { en: name },
    options: { entity_ids: [], prevent_sleep: false },
  };
  remote.data[`/activities/${id}`] = v;
  remote.data[`/activities/${id}/buttons`] = [];
  remote.data[`/activities/${id}/ui/pages`] = [];
  return v;
}

/** Import the remote and adopt it, as a fresh workspace would. */
async function adopted(remote: FakeRemote) {
  const h = remote.harness();
  const { config } = await importConfig(h.client);
  const plan = await makePlan(config, target, h.state, h.adapter);
  await h.engine.apply(plan, h.state);
  return { h, config: structuredClone(config), state: h.getSaved() };
}

const live = async (remote: FakeRemote): Promise<Config> =>
  (await importConfig(remote.harness().client)).config;

test("sync pulls remote edits, keeps local edits, flags conflicts, never writes", async () => {
  const remote = new FakeRemote();
  remote.data["/activities"] = [
    activityOn(remote, "a1", "Watch TV"),
    activityOn(remote, "a2", "Movies"),
    activityOn(remote, "a3", "Games"),
  ];
  const { h, config, state } = await adopted(remote);
  const writes = remote.writes.length;

  // Remote edit on a1, local edit on a2, both on a3.
  (remote.data["/activities/a1"] as any).options.prevent_sleep = true;
  config.resources["activity.movies"]!.data.name = { en: "Cinema" };
  config.resources["activity.games"]!.data.name = { en: "Play" };
  (remote.data["/activities/a3"] as any).name = { en: "Gaming" };

  const r = await syncConfig(
    config,
    state,
    await live(remote),
    remoteGone(h.adapter, state),
  );
  const by = Object.fromEntries(r.changes.map((c) => [c.key, c]));
  assert.equal(by["activity.watch_tv"]?.action, "pull");
  assert.deepEqual(by["activity.watch_tv"]?.fields, ["options.prevent_sleep"]);
  assert.equal(by["activity.movies"]?.action, "local");
  assert.equal(by["activity.games"]?.action, "conflict");
  assert.equal(
    (r.config.resources["activity.watch_tv"]!.data.options as any)
      .prevent_sleep,
    true,
  );
  assert.deepEqual(r.config.resources["activity.movies"]!.data.name, {
    en: "Cinema",
  });
  assert.deepEqual(r.config.resources["activity.games"]!.data.name, {
    en: "Play",
  });
  assert.equal(remote.writes.length, writes);

  // After sync the plan holds exactly the local edit plus the conflict.
  const plan = await makePlan(r.config, target, r.state, h.adapter);
  assert.deepEqual(
    plan.operations.map((o) => [o.key, o.action]),
    [["activity.movies", "update"]],
  );
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0]!, /^activity\.games: Drift at name/);
});

test("sync adds remote-only resources and removes ones deleted on the remote", async () => {
  const remote = new FakeRemote();
  remote.data["/activities"] = [
    activityOn(remote, "a1", "Watch TV"),
    activityOn(remote, "a2", "Movies"),
  ];
  remote.data["/activities/a2/ui/pages"] = [
    { page_id: "p1", name: "Main", grid: { width: 4, height: 6 }, items: [] },
  ];
  const { h, config, state } = await adopted(remote);
  assert.ok(config.resources["activity.movies.page.main"]);

  // a2 (and its page) deleted on the remote, a3 created there.
  remote.data["/activities"] = [
    remote.data["/activities/a1"],
    activityOn(remote, "a3", "Music"),
  ];
  delete remote.data["/activities/a2"];
  delete remote.data["/activities/a2/ui/pages"];
  delete remote.data["/activities/a2/buttons"];

  const r = await syncConfig(
    config,
    state,
    await live(remote),
    remoteGone(h.adapter, state),
  );
  const actions = r.changes.map((c) => `${c.action} ${c.key}`).sort();
  assert.deepEqual(actions, [
    "add activity.music",
    "remove activity.movies",
    "remove activity.movies.page.main",
  ]);
  assert.equal(r.state.bindings["activity.music"]?.id, "a3");
  assert.equal(r.state.bindings["activity.movies"], undefined);
  assert.equal(r.state.revision, state.revision + 1);
  const plan = await makePlan(r.config, target, r.state, h.adapter);
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.conflicts, []);
});

test("sync keeps hand-chosen keys and does not delete what it can't re-read", async () => {
  const remote = new FakeRemote();
  remote.data["/activities"] = [activityOn(remote, "a1", "Watch TV")];
  const { h, state: s0, config: c0 } = await adopted(remote);
  // A user renamed the key; the binding moved with it (state move).
  const config = structuredClone(c0);
  config.resources["activity.tv"] = config.resources["activity.watch_tv"]!;
  delete config.resources["activity.watch_tv"];
  const state = structuredClone(s0);
  state.bindings["activity.tv"] = state.bindings["activity.watch_tv"]!;
  delete state.bindings["activity.watch_tv"];
  (remote.data["/activities/a1"] as any).options.prevent_sleep = true;

  const r = await syncConfig(config, state, await live(remote), async () => {
    throw new Error("must not be asked: nothing is missing");
  });
  assert.deepEqual(
    r.changes.map((c) => [c.key, c.action]),
    [["activity.tv", "pull"]],
  );
  assert.equal(r.config.resources["activity.watch_tv"], undefined);

  // The import silently missing a resource is not a deletion.
  const r2 = await syncConfig(
    config,
    state,
    { schemaVersion: 1, resources: {} },
    remoteGone(h.adapter, state),
  );
  assert.deepEqual(
    r2.changes.filter((c) => c.action === "remove"),
    [],
  );
});

test("parseSource round-trips import output and refuses hand-written code", () => {
  const config: Config = { schemaVersion: 1, resources: {} };
  assert.deepEqual(parseSource(renderSource(config)), config);
  assert.equal(
    parseSource(
      "import { defineRemote, activity } from 'uc-config';\nexport default defineRemote({ schemaVersion: 1, resources: { a: activity({}) } });\n",
    ),
    null,
  );
  assert.equal(
    parseSource(
      "import { defineRemote } from 'uc-config';\nconst tv = 'x';\nexport default defineRemote({});\n",
    ),
    null,
  );
});
