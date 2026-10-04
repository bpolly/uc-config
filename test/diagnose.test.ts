import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeRemote } from "./helpers.js";
import { diagnose, formatDiagnosis } from "../src/diagnose.js";

test("diagnose finds orphaned references and proposes re-add or re-key fixes", async () => {
  const remote = new FakeRemote();
  const cmd = (entity_id: string) => ({
    type: "command",
    command: { entity_id, cmd_id: "media_player.on" },
  });
  remote.data["/intg/instances"] = [
    { integration_id: "tv.main", device_state: "CONNECTED" },
    { integration_id: "avr.main", device_state: "ERROR" },
  ];
  remote.data["/entities"] = [{ entity_id: "tv.main.media_player.ok" }];
  remote.data["/activities"] = [{ entity_id: "act1" }];
  remote.data["/activities/act1"] = {
    entity_id: "act1",
    name: { en: "Watch TV" },
    options: {
      entity_ids: ["tv.main.media_player.ok", "tv.main.media_player.dropped"],
      sequences: {
        on: [cmd("tv.main.media_player.rekeyed"), cmd("gone.main.x")],
      },
    },
  };
  remote.data["/intg/instances/tv.main/entities"] = [
    { entity_id: "media_player.ok", entity_type: "media_player" },
    { entity_id: "media_player.dropped", entity_type: "media_player" },
    {
      entity_id: "media_player.SERIAL",
      entity_type: "media_player",
      name: { en: "TV" },
    },
  ];
  remote.data["/intg/instances/avr.main/entities"] = [];

  const result = await diagnose(remote.harness().client);
  const byId = Object.fromEntries(result.orphans.map((o) => [o.entityId, o]));
  assert.deepEqual(Object.keys(byId).sort(), [
    "gone.main.x",
    "tv.main.media_player.dropped",
    "tv.main.media_player.rekeyed",
  ]);
  assert.equal(byId["tv.main.media_player.dropped"]!.readdable, true);
  assert.match(
    byId["tv.main.media_player.dropped"]!.fix,
    /api POST '\/intg\/instances\/tv\.main\/entities\/media_player\.dropped'/,
  );
  const rekeyed = byId["tv.main.media_player.rekeyed"]!;
  assert.equal(rekeyed.readdable, false);
  assert.deepEqual(
    rekeyed.candidates.map((c) => c.entityId),
    ["tv.main.media_player.dropped", "tv.main.media_player.SERIAL"],
  );
  assert.equal(byId["gone.main.x"]!.integrationId, undefined);
  assert.deepEqual(result.problems, ["Integration avr.main is ERROR"]);
  assert.equal(remote.writes.length, 0, "diagnose must be read-only");
  assert.match(formatDiagnosis(result), /3 orphaned entity reference/);
});
