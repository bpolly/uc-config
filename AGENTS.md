# Working on uc-config

This project manages an Unfolded Circle Remote 3 through TypeScript configuration.
The active source is `remote.config.ts`; it contains an imported setup with stable
remote IDs. Make focused changes and preserve unrelated configuration.

## Read before editing

- Read [docs/configuration-authoring.md](docs/configuration-authoring.md) for syntax,
  editing recipes, ownership, and provisioning conventions.
- Read [README.md](README.md) for CLI behavior and current hardware limitations.
- Read [docs/handoff.md](docs/handoff.md) for the initial verified baseline and
  local state that is intentionally absent from GitHub. Treat it as dated history.
- Treat `src/dsl.ts`, `src/model.ts`, and `src/index.ts` as the implemented public
  API. `DESIGN.md` describes architecture and proposals, not an exact syntax reference.
- Use `generated/devices.ts` and inventory for exact entity IDs and supported
  commands. Refresh inventory when needed; never invent device command names or
  driver setup fields. Native request schemas are in `vendor/core-api.json`.

## Configuration rules

- Preserve logical resource keys, native `id` values, parent relationships, locale
  maps, and unrelated fields. Changing a display name does not require a new ID.
- For an intentional logical-key rename, update references and use `state move`
  to preserve the local binding. Do not silently delete and recreate resources.
- Both native resource objects and exported DSL helpers are supported. Prefer
  small edits to existing imported objects; helper conversions can change defaults,
  locale keys, creation inputs, and ownership.
- Arrays are owned as complete fields. Preserve other entries and ordering when
  changing page items, sequences, or entity membership. Omission relinquishes
  ownership; it does not clear the live field. `[]` explicitly clears a collection.
- Keep commands within the activity/macro's declared entity membership. Remote-local
  commands omit `entity_id`. Pages and button bindings are separate child resources.
- Keep configuration deterministic and free of external side effects. TypeScript
  runs on the local machine at compile time; the remote receives data, not code.
- Never inline secrets or print credential contents. Use `secret()` references.
  Do not hand-edit `.uc` snapshots, plans, state, or credentials to force a result.

## Validation and deployment

For a configuration edit:

```sh
npm run check:examples
npm run uc -- compile
npm run uc -- plan --target living-room
```

Review every operation, conflict, and deferred resource in the resulting plan.
Explain unexpected changes and resolve drift deliberately; do not automatically
use `--overwrite-drift` or `--prune`. A zero-change plan needs no apply.

Apply when deployment is within the user's authorized scope, using the reviewed
plan: `npm run uc -- apply .uc/plan.json`, then `npm run uc -- check`.
An edit request alone need not deploy. Honor existing session authorization without
repeatedly asking for permission. Finish local validation and concrete plan review
before requesting any missing deployment authorization.

Deferred provisioning needs another plan after the current phase completes.
Use `resume` and setup status/response commands for interrupted or interactive
operations; do not blindly replay uncertain creates. Native backups temporarily
stop integrations/docks and are not a routine validation step.

For CLI/library changes, run `npm run check` and `npm test`; also run
`npm run check:examples` when changing the public API. Do not add tests that simply
duplicate configuration values. For documentation-only changes, verify examples
and links; remote access is unnecessary.

`npm run build` builds the CLI. `npm run uc -- compile` compiles configuration;
its output is still named `.uc/build.json`. Do not edit generated `dist/` files or
`src/wire.d.ts` directly. Regenerate wire types only for an intentional schema change.

## User interaction

Use headless browser automation or hidden tabs (`visible: false`) by default.
Do not activate browser windows, switch macOS Spaces, or use desktop input that
interrupts typing. If foreground interaction is necessary, finish independent
background work first, then ask before taking focus and explain why.
