# Code as configuration for Unfolded Circle Remote 3

Status: design with an initial implementation, September 19, 2026. See README.md for the implemented API, verification status, and remaining hardware/device-specific validation. Authenticated inventory/import and local adoption have been verified on the remote. Configuration writes and fresh provisioning remain unverified on hardware. Confirmed requirements: TypeScript configuration and full setup, including integrations and device provisioning.

Build `uc-config`: a local CLI and TypeScript library that turn reusable configuration code into native Remote 3 configuration. Check the source into Git, review a plan, then apply it over the local network. Once deployed, the remote operates without the CLI or your laptop. Any existing integrations retain their own runtime requirements.

## Platform basis

Use the **REST Core API** for configuration. Unfolded Circle identifies the Core APIs as the interfaces behind its UI and web configurator; the Integration API serves device drivers. A new integration driver is unnecessary for this tool. [Official API guide](https://unfoldedcircle.github.io/core-api/)

The inspected upstream OpenAPI document declares version `0.46.0`. Under `/api`, it defines version discovery, entities, activities, remotes, button/UI resources, profiles, API keys, and backup export/restore. Activity creation and subsequent configuration are separate operations. Native backup export temporarily stops integrations and docks; its archive can contain credentials and excludes some device settings. These are published capabilities, not verified capabilities of your remote. [Official REST specification](https://github.com/unfoldedcircle/core-api/blob/main/core-api/rest/UCR-core-openapi.yaml)

Pin the upstream specification to an exact commit during implementation. Detect the target's model, API version, and core version; select a tested adapter and use non-mutating capability checks. Unsupported firmware permits inventory/export but blocks apply. Never infer support from the Remote 3 model name alone or try speculative writes as feature detection.

## First version

Manage the complete setup for the user's actual devices: integration drivers and instances, device discovery and provisioning, selected entities, docks and IR routing, Bluetooth pairing, activities and sequences, macros, physical buttons, remote-entity and activity layouts, assets, profiles/groups, and supported device preferences including the touch slider. Support both importing an existing setup and provisioning a newly connected remote.

Full setup is the first-version acceptance scope, not a promise of support for every third-party integration. Identify the user's device inventory and implement the necessary provisioning adapters before calling the first version complete. Every declared resource must be automated, represented by a specific resumable human step, or reported as unsupported and blocking completion. Include automatic group-placement and other server side effects in plans and verification.

Network reachability and initial authorization are bootstrap prerequisites: a remote must be reachable before the local API can configure it. Record other settings unavailable through the tested API as explicit bootstrap instructions, not silently omitted configuration. Firmware updates are separately planned maintenance actions because they may change the adapter required for subsequent setup.

This is configuration evaluated at deployment time. JavaScript callbacks do not run when a remote button is pressed. A press invokes a native entity command or native sequence; arbitrary runtime logic belongs in a separate integration or automation system.

## Authoring experience

The following is a proposed API, not an existing package. Command tokens come from generated inventory bindings so examples do not assume a device's command names or parameters.

```ts
import { defineRemote, activity, page, button, delay } from "uc-config";
import { tv, receiver, streamer } from "./generated/living-room";

const volumeButtons = {
  VOLUME_UP: receiver.commands.volumeUp(),
  VOLUME_DOWN: receiver.commands.volumeDown(),
  MUTE: receiver.commands.muteToggle(),
};

export default defineRemote({
  schemaVersion: 1,
  activities: {
    watchTV: activity({
      name: "Watch TV",
      entities: [tv, receiver, streamer],
      on: [tv.commands.powerOn(), delay(1500), receiver.commands.powerOn()],
      off: [receiver.commands.powerOff(), tv.commands.powerOff()],
      buttons: {
        ...volumeButtons,
        HOME: streamer.commands.home(),
        BACK: streamer.commands.back(),
      },
      pages: {
        playback: page({
          name: "Playback",
          grid: { columns: 4, rows: 6 },
          items: {
            playPause: button({
              label: "Play / pause",
              at: [0, 0],
              size: [2, 1],
              command: streamer.commands.playPause(),
            }),
          },
        }),
      },
    }),
  },
});
```

`watchTV`, `playback`, and `playPause` are stable logical keys, independent of display names. Renaming a label updates an existing resource. Changing a logical key requires an explicit state move or appears as removal plus addition.

Generate typed command builders only for discovered capabilities; produce stable aliases and retain exact underlying command identifiers. Builders accept typed parameters when metadata supports them. Unknown parameter schemas require explicit raw commands and validation of whatever metadata is available. Compilation validates references, entity inclusion, button/press support, sequence structure, grid bounds, overlapping widgets, and resource limits against the adapter.

TypeScript supplies ordinary functions, loops, imports, and shared presets. Evaluate trusted local source once per compilation into a versioned JSON intermediate representation (IR); the reconciler never executes authoring code. Reject non-serializable output. `plan` records the compiled artifact's hash, and `apply` uses that artifact without evaluating source again. Configuration code has local process privileges; this is not a sandbox for downloaded code.

### Provisioning declarations

The activity example above illustrates one layer. The full configuration also declares dependencies, using adapter-specific typed setup inputs. This schematic example uses placeholders; adapter names, driver IDs, and setup fields must come from the tested adapter catalog.

```ts
const media = integration({
  adapter: "<tested-adapter>",
  driver: { id: "<driver-id>", version: "<pinned-version>" },
  setup: {
    host: "<device-host>",
    token: secret("keychain:uc-config/media-token"),
  },
});

const player = entity({
  integration: media,
  selector: { entityType: "media_player", externalId: "<stable-device-id>" },
});

export default defineRemote({
  schemaVersion: 1,
  integrations: { media },
  entities: { player },
  // docks, remotes, activities, macros, assets, profiles, settings ...
});
```

These helpers produce symbolic IR references. They do not provision devices during evaluation. Secret references resolve only when a setup operation needs them; values never enter source, plans, logs, or normal state. Store write-only secret version metadata separately so rotation can trigger an operation without exporting secret values.

New integrations create an inventory dependency: their entities and dynamic commands may not exist until setup finishes. The planner emits a concrete provisioning phase and marks dependent configuration as unresolved. After provisioning, refresh inventory, bind stable selectors, generate command types, and create a new configuration plan. Do not represent unknown commands as validated or silently expand an approved plan. Existing saved bindings can support offline compilation; apply always verifies them against the target. First-time authoring can therefore require provisioning before completing command-dependent configuration.

## Provisioning lifecycle

Each integration adapter declares discovery, installation/registration, setup, entity selection, read-back, update, and removal capabilities. Pin installable driver artifacts by version and checksum when supported. Built-in drivers and externally hosted drivers have distinct lifecycles; registering an external service does not deploy or host it. Any required external service deployment must be covered by a specified provider or an explicit verified prerequisite.

Setup is a persisted state machine: `planned -> installing -> configuring -> awaiting-user -> discovering-entities -> verifying -> ready`, with `failed` and `unsupported` outcomes. Adapters translate actual driver setup forms and challenges into typed inputs or narrowly scoped prompts. Store setup IDs and progress checkpoints, keep transient credentials in the credential store, and handle expired sessions by restarting only the necessary setup stage.

Bluetooth pairing, device-displayed PINs, OAuth approval, and IR learning may require physical or interactive actions. Show the exact step, persist progress, and resume after it is completed. Do not claim pairing is reproducible from configuration alone. A completed human step is verified through available device state; unverifiable steps remain explicitly attested rather than reported as API-verified.

Provision in dependency order: reachable remote and credentials -> drivers and docks -> integration/device setup -> entity discovery and selection -> IR/Bluetooth remote resources -> assets and macros -> activities/layouts -> profile/group placement and preferences. Actual edges come from references; detect cycles before writes. Newly discovered IDs are bound to logical keys before dependent plans are built. Driver installation and pairing may disrupt connectivity; surface those effects in the plan and reconnect with bounded retries.

Integration replacement or removal requires a dependency-impact plan across entities, activities, and profiles. Update/remove managed references first and block on unmanaged references. Pairing, token issuance, driver upgrades, and external system effects are not generally reversible; recovery reports them explicitly and never promises that configuration rollback undoes them.

## Proposed CLI workflow

```sh
uc-config connect living-room --host remote.local
uc-config inventory --target living-room
uc-config import --target living-room --out remote.config.ts
uc-config compile
uc-config plan --target living-room --out .uc/plans/living-room.json
uc-config apply .uc/plans/living-room.json
uc-config check --target living-room
```

`connect` records target identity and establishes credentials using the supported authentication flow. Keep secrets in the OS credential store or environment. `inventory` exports sanitized entities and command metadata, with explicit user-selected aliases where needed. `import` emits literal, editable TypeScript and a candidate mapping to live resources; it cannot reconstruct the original helper functions behind an existing configuration. Export integrations, provisioning selectors, and other supported resources too; replace credentials with secret references and report write-only settings that require user input. Unsupported fields are reported and preserved, never silently discarded.

For a new setup, create provisioning declarations before the first compilation, apply the provisioning phase, complete any pairing steps, then generate bindings and plan dependent configuration. `uc-config resume --target living-room` inspects pending setup operations and continues or produces a revised plan as appropriate. Import is optional for a fresh remote.

Import alone does not take ownership. A subsequent plan explicitly shows adoption and owned fields; apply records that baseline, even when no remote writes are necessary. Source controls declared fields on adopted resources. Existing unrelated resources remain unmanaged.

Example plan output:

```text
Target: living-room (verified device identity)
~ activity.watchTV.buttons.MUTE: receiver mute -> receiver mute toggle
+ activity.watchTV.pages.playback.items.playPause
= 2 unmanaged activities preserved
2 changes, 0 deletions
```

Keep CLI `apply` explicit; offline compilation and CI validation never contact or modify the remote. No daemon, automatic watch/apply, cloud service, or MCP server is required for the first version.

## Internal architecture

```text
TypeScript source + generated device bindings
                    |
            evaluate / validate
                    v
             canonical JSON IR
                    |
                    v
live inventory -> planner <- last applied state
                    |
           saved operation plan
                    |
             firmware adapter
                    |
           Remote REST Core API
                    |
            read back / verify
```

Suggested modules: `dsl` (authoring types/builders), `compiler` (IR and validation), `core-client` (pinned generated wire types and transport), `adapters` (firmware-specific read/write behavior), `provisioners` (integration/device setup state machines), `credentials` (secret resolution), `planner` (pure reconciliation and phase dependencies), `state` (mappings and journal), and `cli` (workflow).

The domain model must not expose raw REST shapes. Adapters normalize server defaults, localized strings, server-generated IDs, nested options, and firmware-specific layouts. Preserve ordered lists such as sequences and page order; sort only semantically unordered data. Exclude runtime attributes such as current power state from configuration comparisons. Fetch every inventory page and full detail records before planning; list summaries alone are insufficient.

## Identity, ownership, and drift

Maintain per-target state mapping logical keys to returned remote IDs, owned field paths, and last successfully applied values. Also record the target identity and adapter version. Persist state atomically with restricted permissions and back it up separately; do not mix state with credentials or commit raw device snapshots. A shareable bindings file may contain aliases and stable selectors but no secrets.

Resolve dependencies through saved IDs plus integration/type metadata. Names are useful for initial discovery but are not unique identifiers. Ambiguous matches, missing entities, or identity mismatches fail planning. Re-pairing an integration requires explicit rebinding if IDs change. Do not silently attach a configuration to the first similarly named device.

Use a three-way comparison of desired configuration, last applied values, and live configuration:

| Change | Default behavior |
| --- | --- |
| Only source changed | Plan the source change. |
| Only a managed live field changed | Report drift; require explicit adopt or overwrite resolution. |
| Source and remote changed to the same value | Accept the common value. |
| Source and remote changed differently | Report a conflict and block apply. |
| Unmanaged field changed | Preserve it. |
| Previously managed resource disappeared | Report drift; require explicit recreation resolution. |

An explicit `undefined`/omitted field relinquishes ownership without deleting its live value; use a dedicated `clear()` marker where clearing is supported. Removing a previously managed resource produces a proposed deletion requiring `plan --prune`; otherwise report it as pending removal. Removing a never-managed resource is outside the tool's scope. Resource deletion checks all known inbound references and blocks when unmanaged references would break. Never use bulk-delete endpoints.

For endpoints that replace whole collections, build the replacement from a fresh full read, overlay owned changes, and retain unmanaged entries and unknown fields. Block apply if the adapter cannot preserve them safely. Store collection ordering as an explicitly owned property when code controls it.

## Apply and recovery

1. Acquire a local lock per target. Verify saved plan integrity, target identity, adapter version, state revision, and live configuration preconditions. Exclude transient runtime state from these hashes. Reject stale plans.
2. Save protected before-images of affected configuration. Offer a separate native-backup command for broader recovery; do not silently invoke the disruptive full backup on every apply.
3. Order operations by the provisioning/configuration dependency graph. Persist setup checkpoints and returned IDs, pause dependent work for human steps or inventory-dependent replanning, configure references/sequences/buttons/pages, update placement, then perform planned deletions. Apply never executes configured activity power or media sequences as a test. Provisioning commands needed for pairing or learning are separate, visible operations.
4. Before each mutation, re-read the affected resource and check its precondition. Use conditional writes if the tested API supports them. Otherwise concurrent edits remain a race; ask users to avoid configurator edits during apply and detect mismatches through immediate read-back.
5. Journal operation intent before sending requests and completion after verification. Persist newly allocated IDs immediately. Never blindly retry a timed-out create. If success is uncertain, stop and reconcile the live inventory before retrying; ambiguous identity requires explicit adoption.
6. Read back and compare all managed configuration. Advance the applied baseline only for verified operations, tracking explicit attestations separately where an API cannot verify a bootstrap step. Completion requires no unresolved provisioning steps, no unsupported declared resources, and an empty subsequent plan.

Do not assume multi-resource transactions. On failure, stop dependent operations and report exactly what completed, what remains, and what is uncertain. `resume` re-reads reality and produces a new plan using the journal. `rollback` produces a compensating plan from before-images, checks for subsequent edits, and identifies irreversible effects. Recreated deleted resources may have different IDs. Native restore is a separate recovery action, not an automatic response to a failed patch.

Local locks do not coordinate multiple laptops. Version one supports a single writer/state store per target. Shared state and distributed locking can follow if needed.

## Delivery sequence and acceptance

1. **Inventory and import:** authenticate, identify actual firmware, capture sanitized fixtures, enumerate entities/commands, and export one existing activity without writes. Exit criterion: imported configuration round-trips without semantic differences or omitted unsupported-field warnings.
2. **Offline compiler and planner:** implement the DSL, IR, ownership rules, and readable plans against fixtures. Test normalization, drift conflicts, duplicate names, logical renames, and preservation of unknown fields.
3. **Provision the actual device inventory:** implement the required integration, dock, IR, and Bluetooth adapters. Test clean setup, adoption, credentials, pairing interruptions, expired sessions, and entity discovery. A second provisioning pass must not duplicate integrations or restart completed pairing unnecessarily.
4. **Configure the complete remote:** manage activities, sequences, buttons, layouts, macros, assets, profiles/groups, and supported preferences. Verify on the target, then require a zero-change plan. Existing unmanaged resources remain unaffected.
5. **Recovery and first-version acceptance:** test interrupted provisioning/apply, create timeouts, stale plans, unavailable devices, integration replacement, and configurator edits. Add deletion and recovery after these cases are handled. Verify setup from a clean reachable target or equivalent test fixture without resetting the user's remote. The first version is complete only when the user's full declared setup is reproducible, necessary human steps are documented and resumable, and no declared resources remain unsupported. Earlier milestones are implementation slices, not a reduced first-version scope.

The first implementation needs the remote's address, API/core versions, and authenticated read access. Those details do not change the overall architecture; they determine the first adapter and the concrete command bindings. Device input selection, power delays, and actual living-room devices should come from your inventory rather than assumed examples.
