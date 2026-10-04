# Authoring Remote 3 configuration

Edit `remote.config.ts`. It exports a `defineRemote({ schemaVersion: 1, resources })`
object. TypeScript constants, functions, imports, and object spreads can reuse
configuration, but the final value must be plain JSON-compatible data. Avoid
`undefined`, functions, class instances, cycles, non-finite numbers, and side effects.
Compile executes this trusted code locally; it does not install JavaScript on the remote.

## Resource anatomy and identity

Each `resources` key is a stable local name. The resource describes native API data:

```ts
import { defineRemote, ref } from "uc-config";

export default defineRemote({
  schemaVersion: 1,
  resources: {
    "activity.watch_tv": {
      kind: "activity",
      id: "EXISTING_ACTIVITY_ID",
      data: { name: { en_US: "Watch TV" } },
    },
    "activity.watch_tv.button.volume_up_short_press": {
      kind: "activityButton",
      parent: ref("activity.watch_tv"),
      id: "VOLUME_UP/short_press",
      data: {
        short_press: {
          entity_id: "EXACT_CONFIGURED_ENTITY_ID",
          cmd_id: "EXACT_SUPPORTED_COMMAND_ID",
          params: {},
        },
      },
    },
  },
});
```

This is a structural example with placeholders, not a deployable setup. The command
target also needs to be in the activity's `options.entity_ids` before using the binding.

| Field                  | Meaning                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Resource map key       | Local identity used by references, plans, and state; not a display name.                                  |
| `kind`                 | Supported resource kind from `src/model.ts`.                                                              |
| `id`                   | Exact native remote ID, or kind-specific identity such as `VOLUME_UP/short_press`. Preserve existing IDs. |
| `parent`               | Native parent ID or `ref("logical.key")`.                                                                 |
| `data`                 | Desired writable fields this configuration owns.                                                          |
| `create`               | Native creation/setup payload; distinct from update data. Imported resources may lack it.                 |
| `dependsOn`            | Additional logical resource keys that must be ready first. References also establish dependencies.        |
| `file`, `resourceType` | Local artifact path and asset type for the applicable helpers. Compilation records a content hash.        |

Use unique keys. JavaScript object construction can overwrite duplicate keys before
validation. Renaming a key requires updating its references and running
`npm run uc -- state move OLD NEW`; changing `data.name` does not.

## Editing the imported setup

Keep the existing native objects unless a reusable helper makes the requested change
clearer. Rewriting an imported activity with `activity()` can change its locale map
(`en_US` versus the helper's `en`), add creation inputs, or change owned fields.

- **Rename a displayed activity:** edit its existing `data.name` locale entry.
  Preserve its logical key, `id`, and other locales.
- **Change a physical button:** locate its `activityButton` or `remoteButton`
  resource by parent and button ID. Edit the command under `data.short_press` or
  `data.long_press`; preserve the other bindings. Button IDs use uppercase names
  and a press suffix, for example `HOME/long_press`.
- **Change a sequence:** edit `data.options.sequences.on` or `.off` for activities,
  or `data.options.sequence` for macros. Native command steps use
  `{ type: "command", command: { entity_id, cmd_id, params } }`; delays use
  `{ type: "delay", delay: 500 }` (milliseconds). Preserve order and other steps.
- **Change a screen:** edit the appropriate child `activityPage` or `remotePage`.
  Native items use `location: { x, y }` and optional `size: { width, height }`.
  Coordinates are zero-based; items must fit the grid and not overlap.
- **Use another device:** verify its exact configured entity ID and supported
  command metadata, then include it in the activity/macro's entity membership.
  Display names and available integration entity IDs are not interchangeable with
  configured command target IDs.

Arrays are owned as whole fields, including page items, sequences, and entity
membership. Keep unrelated entries when editing one item. Omitting a field gives
up ownership without clearing its live value; `[]` explicitly clears a collection.
Use only native-schema-supported empty values for other fields.

Do not reimport over the active source to change one setting. If live values must
be inspected, import to a new file and selectively reconcile the relevant fields.
Treat generated inventory/bindings as discovery snapshots that may need refreshing.

## Composing new resources with helpers

The helper API produces the same resource objects. This example uses placeholders
that must be replaced with verified inventory values:

```ts
import {
  activity,
  bind,
  button,
  command,
  defineRemote,
  delay,
  page,
  ref,
} from "uc-config";

const player = "EXACT_CONFIGURED_ENTITY_ID";
const home = command(player, "EXACT_SUPPORTED_HOME_COMMAND_ID");

export default defineRemote({
  schemaVersion: 1,
  resources: {
    "activity.watch": activity({
      name: "Watch",
      entities: [player],
      on: [home, delay(500)],
    }),
    "activity.watch.home": bind(ref("activity.watch"), "HOME", home),
    "activity.watch.controls": page(ref("activity.watch"), {
      name: "Controls",
      grid: { width: 4, height: 6 },
      items: [button({ label: "Home", at: [0, 0], command: home })],
    }),
  },
});
```

Helpers `activity({ on, off })` and `macro({ steps })` wrap command steps for you;
do not pass already-wrapped native command steps to these arrays. `button()` takes
`at: [x, y]` and optional `size: [width, height]`, unlike native item objects.

`bind(parent, button, command, press, scope)` defaults to `short_press` and
`activity`. `page(parent, data, id, scope)` also defaults to activity scope.
For remote children choose `"remote"`; for commands local to that remote use
`localCommand(cmdId, params?)`, which omits `entity_id`. Verify supported commands
instead of inferring their names.

For native structures without a dedicated helper, use `resource(kind, options)`.
Exported `Schemas` exposes native request types. See [the complete template](../examples/full-setup.ts)
and [the helper implementation](../src/dsl.ts) for exact signatures.

## Integrations and provisioning

Use the driver's advertised setup schema; there is no universal device setup payload.
`integration()` takes a driver ID/reference, name, and driver-specific `setup` data.
`entity()` selects one exact available entity using its integration parent and
`entityId`. Do not configure every discovered entity implicitly.

`driver()` registers an already-running external service; it does not deploy that
service. `driverArchive()` installs a local archive. `dock()`, `remote()`,
`pairing()`, and `irCode()` cover their respective native setup resources. See the
README and complete template before adding these resources.

Use `secret("env:VARIABLE")` or `secret("keychain:service/account")` for secret
inputs. An optional second argument is a non-secret rotation version. Never put
PINs/API keys into source or print `.uc/credentials.json`.

New resources may require multiple plan/apply phases. Integration setup and pairing
can pause for user interaction. Inspect `setup status`, provide the requested input
through `setup respond`, and use `resume` as documented in [the CLI reference](cli.md). Replan after
each completed phase; never bypass deferred dependency or command validation.

Imported configuration is not a full disaster-recovery backup: original setup
credentials, driver archives, and binary assets may be missing. Installing and
updating community integrations is handled by the
[UC Integration Manager](https://github.com/JackJPowell/uc-intg-manager); run
`npm run uc -- diagnose` after any integration update.

## Review and apply

```sh
npm run check:examples
npm run uc -- compile
npm run uc -- plan --out .uc/plan.json
```

Typechecking checks source shape. Compile evaluates source and validates local
structure into `.uc/build.json`. Plan reads the remote and compares desired values,
live values, and the local baseline; it does not deploy changes. Inspect all
operations, deferred work, and conflicts. Do not automatically resolve drift by
adding `--overwrite-drift`. Removing resources requires an intentional prune or
`state forget`; see [the CLI reference](cli.md) for supported removal behavior.

When deployment is authorized, apply the reviewed plan, then verify:

```sh
npm run uc -- apply .uc/plan.json
npm run uc -- check
```

After any source change, compile and plan again. Never hand-edit a plan or local
state to bypass validation. A plan with no changes needs no apply. An adoption-only
plan can use `apply .uc/plan.json --adopt-only` to record ownership locally while
refusing remote writes. `npm run build` builds the CLI itself; it is separate from
configuration compilation.
