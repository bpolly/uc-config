# Snippets: common tasks

Copy-paste recipes for the things people most often ask for. Each one ends with
the same validation loop:

```sh
npm run uc -- compile && npm run uc -- plan --out .uc/plan.json
# review: only the intended resources may change
npm run uc -- apply .uc/plan.json && npm run uc -- check
```

Ground rules (see [AGENTS.md](../AGENTS.md)):

- Get every entity ID and `cmd_id` from `generated/devices.ts` or a fresh
  inventory. Never guess command names.
- A command used in an activity must belong to an entity in that activity's
  `entity_ids`.
- Arrays (`entity_ids`, sequences, page `items`) are replaced whole. Keep the
  existing entries and their order.
- Imported configs use native objects; new resources can use the helpers
  (`activity()`, `bind()`, `page()`, ...). Both forms are valid together.

## Finding things

```sh
# Which entities exist and what commands do they accept?
grep -n 'name:' generated/devices.ts
grep -n 'Apple TV' generated/devices.ts

# Refresh bindings after adding devices/integrations (files are never overwritten)
npm run uc -- inventory --bindings .uc/devices-$(date +%F).ts

# Where is a resource defined?
grep -n '"activity\.' remote.config.ts | grep -v '\.button\.\|\.page\.'   # activities
grep -n 'activity.watch_tv.button' remote.config.ts                        # its buttons
grep -n '<entity-id>' remote.config.ts                                     # every use of an entity

# Raw API reads (redacted)
npm run uc -- api GET /activities
npm run uc -- api GET '/intg/instances/<integration_id>/entities?filter=ALL'
```

Physical button names: `BACK HOME VOICE VOLUME_UP VOLUME_DOWN MUTE DPAD_UP
DPAD_DOWN DPAD_LEFT DPAD_RIGHT DPAD_MIDDLE CHANNEL_UP CHANNEL_DOWN PREV PLAY
NEXT POWER RECORD MENU STOP`. Check `npm run uc -- api GET /cfg/device/button_layout` for the exact list.

## Remap a physical button in an activity

Imported form: change only `cmd_id` (and `entity_id` if needed).

```ts
"activity.watch_kaleidescape.button.next_short_press": {
  kind: "activityButton",
  parent: { $ref: "activity.watch_kaleidescape" },
  id: "NEXT/short_press",
  data: {
    short_press: {
      entity_id: "kaleidescape.main.media_player.XXXX",
      cmd_id: "media_player.next",          // was media_player.fast_forward
      params: {},
    },
  },
},
```

New binding with the helper:

```ts
import { bind, command, ref } from "uc-config";

"activity.watch_tv.button.menu": bind(
  ref("activity.watch_tv"),
  "MENU",
  command(appleTv, "media_player.context_menu"),
),
```

## Add a long-press action

```ts
"activity.watch_tv.button.home_long": bind(
  ref("activity.watch_tv"),
  "HOME",
  command(appleTv, "APP_SWITCHER"),
  "long_press",
),
```

## Route volume to the receiver in every activity

```ts
const receiver = "onkyo_driver.main.media_player.XXXX";
const volumeButtons = (activityKey: string) => ({
  [`${activityKey}.button.vol_up`]: bind(ref(activityKey), "VOLUME_UP", command(receiver, "media_player.volume_up")),
  [`${activityKey}.button.vol_down`]: bind(ref(activityKey), "VOLUME_DOWN", command(receiver, "media_player.volume_down")),
  [`${activityKey}.button.mute`]: bind(ref(activityKey), "MUTE", command(receiver, "media_player.mute_toggle")),
});

resources: {
  ...volumeButtons("activity.watch_tv"),
  ...volumeButtons("activity.play_ps5"),
}
```

If an activity already has imported `VOLUME_UP/short_press` resources, edit
those instead. Two resources with the same parent and `id` conflict.

## Add an entity to an activity

Append to `entity_ids` and keep the existing order. Required before any of its
commands can be used in that activity.

```ts
options: {
  entity_ids: [
    "lgwebos_driver.main.media_player.XXXX",
    "onkyo_driver.main.media_player.XXXX",
    "kaleidescape.main.remote.XXXX",        // added
  ],
},
```

## Change an activity's power-on / power-off sequence

```ts
sequences: {
  on: [
    { type: "command", command: { entity_id: tv, cmd_id: "media_player.on", params: {} } },
    { type: "delay", delay: 2000 },
    { type: "command", command: { entity_id: receiver, cmd_id: "media_player.select_source", params: { source: "BD/DVD" } } },
  ],
  off: [
    { type: "command", command: { entity_id: receiver, cmd_id: "media_player.off", params: {} } },
    { type: "command", command: { entity_id: tv, cmd_id: "media_player.off", params: {} } },
  ],
},
```

`select_source` values are entity-specific. Copy them from an existing sequence
or the entity's `attributes.source_list` (`npm run uc -- api GET /entities/<id>`).

## Create a new activity

```ts
import { activity, command, delay, ref, bind, page, button } from "uc-config";

"activity.movie_night": activity({
  name: "Movie Night",
  entities: [tv, receiver, player, lights],
  on: [
    command(lights, "light.off"),
    command(tv, "media_player.on"),
    delay(1500),
    command(receiver, "media_player.on"),
  ],
  off: [command(receiver, "media_player.off"), command(tv, "media_player.off")],
}),
"activity.movie_night.button.play": bind(ref("activity.movie_night"), "PLAY", command(player, "media_player.play_pause")),
```

New activities apply in two phases: the first apply creates the activity and
its entity membership, then **plan again** to apply buttons/pages (`deferred`
in the plan output tells you this).

## Add a touchscreen page with buttons

```ts
"activity.watch_tv.page.apps": page(ref("activity.watch_tv"), {
  name: "Apps",
  grid: { width: 4, height: 6 },
  items: [
    button({ label: "Netflix", at: [0, 0], size: [2, 1], command: command(tv, "NETFLIX") }),
    button({ label: "Prime",   at: [2, 0], size: [2, 1], command: command(tv, "AMAZON") }),
    button({ label: "Fix Inputs", at: [1, 2], size: [2, 2], command: command(fixMacro, "macro.run") }),
  ],
}),
```

Items must fit within the grid and must not overlap. For an existing imported
page, edit its `items` array in place.

## Create a macro ("fix inputs" style)

```ts
import { macro, command, delay } from "uc-config";

"macro.fix_inputs": macro({
  name: "Fix Inputs",
  entities: [tv, receiver],
  steps: [
    command(tv, "media_player.select_source", { source: "HDMI 2" }),
    delay(500),
    command(receiver, "media_player.select_source", { source: "BD/DVD" }),
  ],
}),
```

Run it from a button or page with `command("<macro entity id>", "macro.run")`.
For an existing macro the entity ID is its `id` in `remote.config.ts`. For a
new one, apply first, then read it from `npm run uc -- api GET /macros`.

## Touch slider target

```ts
options: {
  touch_slider: { enabled: true, target: { entity_id: "lutron_driver.main.light.XXXX" } },
},
```

## Rename an activity / page

Change the display name only; keep the resource key and `id`:

```ts
data: { name: { en_US: "Watch Movies" } },   // was "Watch Kaleidescape"
```

To rename the _logical key_ too, edit the key and every `ref()`/`$ref` to it,
then run `npm run uc -- state move OLD_KEY NEW_KEY`.

## Device settings

```ts
import { settings } from "uc-config";

"settings.display": settings("display", { brightness: 60, auto_brightness: true }),
"settings.haptic": settings("haptic", { enabled: true }),
```

Only declared fields are owned. Sections: `device display button haptic
localization power_saving sound bt profile voice_control`.

## Repair after an integration update (orphaned entities)

```sh
npm run uc -- diagnose
```

**Entity dropped but still offered** (diagnose prints `fix: Re-add ...`):

```sh
npm run uc -- api POST '/intg/instances/<integration_id>/entities/<local_id>' --data '{}' --write
npm run uc -- diagnose          # expect All clear
npm run uc -- plan              # expect 0 operations
```

**Entity re-keyed** (diagnose lists a `candidate`):

```sh
npm run uc -- api POST '/intg/instances/<integration_id>/entities/<candidate_local_id>' --data '{}' --write
grep -n '<old-entity-id>' remote.config.ts      # entity_ids, sequences, buttons, pages, macros
# replace every occurrence with the new ID, then:
npm run uc -- compile && npm run uc -- plan --out .uc/plan.json && npm run uc -- apply .uc/plan.json
npm run uc -- diagnose
```

Buttons and sequences that use the new entity show up as **deferred** until the
activity's `entity_ids` change is on the remote. Apply the plan, then plan and
apply again for the deferred items. `check` must report 0 operations at the
end.

**Drift from a driver renaming something** (`Drift at data.name`): copy the
live value (shown in the plan) into source, then:

```sh
npm run uc -- state forget <key> && npm run uc -- state adopt <key> <native-id>
npm run uc -- compile && npm run uc -- plan --out .uc/plan.json
npm run uc -- apply .uc/plan.json --adopt-only
```

## Pull changes made in the web configurator

```sh
npm run uc -- import --out .uc/imported-$(date +%F).config.ts
npm run uc -- compile --config .uc/imported-$(date +%F).config.ts --out .uc/imported-build.json
diff <(jq -S . .uc/build.json) <(jq -S . .uc/imported-build.json) | less
```

Imported keys are generic (`activity3`). Match resources by `kind` + `id` and
copy the changed fields into `remote.config.ts`. Then `plan` should report
0 operations.

## Undo the last apply

```sh
npm run uc -- rollback --out .uc/rollback.json   # builds a compensating plan
# review it like any plan, then:
npm run uc -- apply .uc/rollback.json
```

## Back up everything (scheduled job friendly)

```sh
D=backups/$(date +%F); mkdir -p "$D"
npm run -s uc -- inventory --out "$D/inventory.json"           # redacted raw state
npm run -s uc -- import --out "$D/remote.config.ts"            # readable snapshot
tar czf "$D/dotuc.tgz" --exclude credentials.json .uc          # ownership state
curl -sf http://<REMOTE_IP>:9999/api/backups/download -o "$D/intg-manager.json"  # Integration Manager
```

`npm run uc -- backup --out PRIVATE_PATH` produces the remote's native full
backup, but it **temporarily stops integrations and docks**, so don't schedule it.

## Nightly health check (for an agent cron job)

```sh
npm run -s uc -- diagnose --json > .uc/diagnose.json; d=$?
npm run -s uc -- plan --out .uc/plan-nightly.json; p=$?
echo "diagnose=$d plan=$p"     # 0/0 = healthy; 2 = needs attention
```

Report findings, and fix only the clear-cut cases (re-add a dropped entity that
is still offered). Escalate everything else to the user.
