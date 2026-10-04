# CLI reference

Run as `npm run uc -- <command>` inside this repo, or `npx uc-config <command>`
when installed as a dependency. Global option: `--workspace <dir>` (directory
holding `remote.config.ts` and `.uc/`; default: current directory).

Most commands take `--target <name>`. The default is `$UC_TARGET`; otherwise
the workspace's only target if exactly one is connected; otherwise `home`.

## Commands

| Command                                        | Writes to remote  | Purpose                                                                        |
| ---------------------------------------------- | ----------------- | ------------------------------------------------------------------------------ |
| `init [--host ip] [--no-connect]`              | API key only      | Scaffold a workspace, then prompt for IP and PIN (connect + auth). Rerunnable. |
| `init --refresh-docs`                          | no                | Update AGENTS.md/CLAUDE.md; edited files are kept and get a `.new` copy.       |
| `connect <name> --host <url>`                  | no                | Record a target (identity, firmware). Rerun after firmware updates.            |
| `auth`                                         | API key only      | Exchange the web-configurator PIN (`UC_PIN` or prompt) for an API key.         |
| `doctor`                                       | no                | Verify identity and read access to every required endpoint.                    |
| `diagnose [--json]`                            | no                | Orphaned entity references, disconnected integrations, suggested fixes.        |
| `inventory [--out f] [--bindings f.ts]`        | no                | Raw (redacted) remote state; optional typed entity/command bindings.           |
| `import [--out f.ts]`                          | no                | Generate editable config from the live remote. Never overwrites.               |
| `sync [--dry-run]`                             | no                | Pull the live remote into source, state and bindings; keeps local edits.       |
| `compile [--config f] [--out f]`               | no                | Evaluate TS config into `.uc/build.json`. Offline.                             |
| `plan [--out f] [--prune] [--overwrite-drift]` | no                | Three-way diff: source vs last-applied vs live.                                |
| `apply <plan> [--adopt-only]`                  | yes               | Execute a saved plan after re-verifying preconditions.                         |
| `check`                                        | no                | Re-plan and exit 2 if anything differs.                                        |
| `resume`                                       | maybe             | Continue paused setup; reconcile an interrupted apply.                         |
| `setup status/respond <key>`                   | yes               | Drive interactive integration/dock setup.                                      |
| `pairing status/respond <remoteId>`            | yes               | Bluetooth pairing steps.                                                       |
| `ir learn/capture <emitterId>`                 | yes               | Learn IR codes from a physical remote.                                         |
| `state adopt <key> <id>` / `forget` / `move`   | no                | Edit local ownership bindings.                                                 |
| `rollback [--out f]`                           | no                | Build a compensating plan from the last journal.                               |
| `backup [--out f] [--list] [--intg-manager u]` | stops intgs       | Native backup + Integration Manager export to `backups/`; keeps old ones.      |
| `api <METHOD> <path> [--data json] [--write]`  | only with --write | Raw authenticated Core API call; output redacted.                              |

Exit codes: `0` ok, `1` error, `2` drift/conflicts/deferred/diagnose findings,
`3` paused for a human step.

## Authentication

`init` runs `connect` and `auth` for you when started in a terminal. Without a
terminal (e.g. run by an agent) it only scaffolds files unless `--host` and
`UC_PIN` are supplied. Steps already completed are skipped on reruns.

`auth` prompts for the web configurator PIN. Enable the web configurator on the
remote first, and approve the key on the remote if asked. Non-interactive
options: set `UC_PIN`, or set `UC_API_KEY` to an existing key (`connect
--token-env NAME` changes the variable name). The key is stored in
`.uc/credentials.json` with mode 0600. Never commit or print it.

Configuration secrets use `secret('env:NAME')` or, on macOS,
`secret('keychain:service/account')`. An optional second argument is a
non-secret version label that triggers rotation. Raw secret values never appear
in plans, state or journals.

## Adopting an existing remote

`import` generates config without taking ownership. The first `plan` shows
`= adopt` operations; `apply <plan> --adopt-only` records the baseline locally
and refuses any remote write. Import warnings list what can't be recovered,
such as original setup credentials, driver archives and binary assets.

## Provisioning (new integrations, docks, remotes)

A new dependency is created before its dependents. When a plan reports
**deferred** resources, apply the current phase, then **plan again**. Newly
created activities and macros first receive their entity membership, which
exposes the command metadata needed to validate their sequences and buttons.

```sh
npm run uc -- setup status media
npm run uc -- setup respond media --input setup-response.json   # {"input_values": {...}}
npm run uc -- setup respond media --confirm
npm run uc -- resume
npm run uc -- plan
```

Secret-bearing setup values can be written as `{"$secret":"env:DEVICE_PIN"}`.
Expired or rejected setup sessions are reported, never silently restarted.

```sh
npm run uc -- pairing status REMOTE_ENTITY_ID
npm run uc -- pairing respond REMOTE_ENTITY_ID --input pairing-response.json  # {"id":11,"passkey":{"$secret":"env:BT_PASSKEY"}}
npm run uc -- ir learn EMITTER_ID
npm run uc -- ir capture EMITTER_ID --out learned.json
```

Installing _community_ integrations (download, version selection, updates) is
the [UC Integration Manager](https://github.com/JackJPowell/uc-intg-manager)'s
job. uc-config's `driver()` registers an already-running external driver, and
`driverArchive()` uploads a local archive.

## Ownership, recovery and removal

- Plans compare three things: source, the last applied state and live data.
  Live edits to owned fields produce conflicts. Copy the live value into source
  to accept it; `plan --overwrite-drift` restores the source value instead.
- Apply verifies identity, firmware, state revision, plan integrity and live
  preconditions, and re-reads before each mutation. The Core API is not
  transactional, so avoid configurator edits while an apply runs.
- Per-target locks prevent two local writers. A lock left by a crashed process
  is kept until someone inspects it.
- Failed or uncertain writes block the next apply until `resume` runs. A create
  whose outcome is unknown is never replayed; inspect inventory and run
  `state adopt KEY EXACT_ID` if it succeeded.
- `state move OLD NEW` keeps the remote ID when you rename a logical key.
  `state forget KEY` gives up ownership without deleting anything.
- Removing a managed resource from source needs `plan --prune` or
  `state forget`. Pruning checks inbound references and never bulk-deletes.
  Integration, driver, dock and entity removal is blocked; handle it explicitly.
- `rollback` refuses when there is later drift, created or deleted resources,
  fields that were previously absent, or irreversible provisioning.
  Earlier journals stay in `.uc/journals/history/`.

## Ownership rules for arrays and fields

Arrays (page items, sequences, entity membership) are owned as whole fields.
Omitting a scalar or object field gives up ownership without clearing it. To
clear a collection, declare `[]`. Page-item defaults returned by the remote are
ignored when you didn't declare them.

## Limits

- Import is not a full disaster-recovery export. Setup secrets, driver binaries
  and some assets cannot be read back.
- The API doesn't expose installed driver digests, so a driver replaced out of
  band can't be fully detected.
- Immutable creation fields (e.g. IR remote codeset) need an explicit
  replacement.
- Firmware installs, Wi-Fi bootstrap and external-service deployment are out of
  scope.
