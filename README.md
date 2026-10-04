# uc-config

Configuration-as-code for the [Unfolded Circle Remote 3](https://www.unfoldedcircle.com/).
Describe activities, button mappings, pages, macros, integrations and settings in
TypeScript, review a plan against the live remote, then apply it over the local
Core API. Nothing runs on the remote except its own native configuration.

**This project is built to be driven by a coding agent** (Claude Code, Codex,
Cursor, Hermes, etc.). A person states the intent ("make the play button on the
Apple TV activity skip chapters") and the agent edits config, validates, plans,
and applies. The guardrails (three-way drift detection, saved plans, write
journals, read-only diagnostics) exist so an agent can operate safely on real
hardware. Humans can use it directly too.

> Agents: read [AGENTS.md](AGENTS.md) first, then [docs/snippets.md](docs/snippets.md)
> for copy-paste recipes. Ask the user only for what you cannot discover:
> the remote's IP address and the web configurator PIN.

## Requirements

- Node.js 22+ and npm
- A Remote 3 on the same LAN, with the **web configurator enabled**
  (Settings → Profile → Web configurator) and its PIN
- Optional but recommended: the [UC Integration Manager](#integration-manager)

Tested against Remote 3 core `0.81.x`, API `0.19.0`. Firmware changes are detected
and block writes until you reconnect.

## Setup (agent runbook)

Run these from the repository root. Each step is idempotent or fails safely.

```sh
# 1. Install and build the CLI (dist/ is required by remote.config.ts imports)
npm install
npm run build
npm test                                   # offline, uses a mock Core API

# 2. Register the remote ("living-room" is the default target name;
#    pick any name and pass --target <name>, or export UC_TARGET=<name>)
npm run uc -- connect living-room --host http://<REMOTE_IP>

# 3. Authenticate. Prompts for the web-configurator PIN in a TTY.
#    Headless agents: have the user run this step, or pass UC_PIN in the env.
#    Never write the PIN or key into files or chat logs.
npm run uc -- auth --target living-room

# 4. Verify connectivity and API coverage
npm run uc -- doctor

# 5. Snapshot what is on the remote
npm run uc -- inventory --bindings generated/devices.ts   # entity IDs + commands
npm run uc -- import --out remote.config.ts               # editable config
npm run uc -- diagnose                                    # health check

# 6. Take ownership (local only; writes nothing to the remote)
npm run uc -- compile
npm run uc -- plan --out .uc/plan.json        # expect only "= adopt" operations
npm run uc -- apply .uc/plan.json --adopt-only

# 7. Confirm convergence
npm run uc -- check                           # 0 operations, 0 conflicts
```

After step 7 the workspace is ready. Every later change follows the edit loop below.

Notes for agents:

- `auth` stores the API key in `.uc/credentials.json` (mode 0600). Alternatively
  set `UC_API_KEY` to an existing key. If a key named `uc-config` already exists
  on the remote, reuse it or revoke it in the configurator first.
- `inventory`/`import` refuse to overwrite existing files (`wx`). Use new,
  dated filenames when refreshing (e.g. `.uc/devices-2026-10-03.ts`).
- On macOS, if Node is denied Local Network access the CLI falls back to `curl`
  automatically. If _every_ LAN device is unreachable but the router answers,
  grant Local Network permission to the terminal app that launched the agent.
- `remote.config.ts`, `generated/` and `.uc/` are gitignored: they describe
  your home and contain credentials. Keep them in a private repo or backup
  (see [Keeping your config private](#keeping-your-config-private)).

## The edit loop

```sh
# edit remote.config.ts
npm run check:examples          # typecheck config + examples
npm run uc -- compile           # evaluate TS -> .uc/build.json (offline)
npm run uc -- plan --out .uc/plan.json
# read every operation, conflict and deferred item; nothing unexpected allowed
npm run uc -- apply .uc/plan.json
npm run uc -- check             # must report 0 operations
```

`plan` never writes. `apply` only executes a saved, reviewed plan and re-verifies
remote identity, firmware and preconditions first. A plan with zero operations
needs no apply. See [docs/snippets.md](docs/snippets.md) for common edits.

## Diagnostics and fixing problems

Run `diagnose` whenever something looks wrong on the remote, after any
integration update, and before large changes:

```sh
npm run uc -- diagnose          # human-readable; exit 2 if problems found
npm run uc -- diagnose --json   # for agents
```

It is read-only and reports:

- **Orphaned entity references**: activities/macros pointing at an entity that
  no longer exists (the remote shows these as "orphaned" or "unavailable").
- **Disconnected integrations**: any integration not in `CONNECTED` state.

For each orphan it proposes a fix:

| Diagnosis                                            | Cause                                                    | Fix                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Integration still offers the same entity             | Integration update/reinstall dropped configured entities | Re-add it with the printed `api POST ... --write` command, then `plan` (expect 0 ops)      |
| Integration offers a _different_ entity of same type | Driver re-keyed the device (e.g. MAC → serial ID)        | Re-add the candidate, replace the old ID **everywhere** in `remote.config.ts`, plan, apply |
| Integration not `CONNECTED`                          | Device offline, credentials changed, driver crashed      | Reconnect in the configurator or Integration Manager, rerun `diagnose`                     |
| No integration owns the ID                           | Integration removed                                      | Reinstall it (often via the Integration Manager) or remove the references                  |

Plan/apply problems:

| Message                                         | Meaning and fix                                                                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Drift at <fields>`                             | Someone (or a driver update) changed an owned field on the remote. Copy the live value into source, or rerun `plan --overwrite-drift` only if the user wants the source value restored. |
| `Managed resource disappeared`                  | Resource was deleted on the remote. Run `diagnose`; re-add or remove from source.                                                                                                       |
| `Cannot verify command`                         | `cmd_id` isn't advertised by that entity, or the entity isn't in the activity's `entity_ids`. Check `generated/devices.ts`, refresh inventory.                                          |
| `Remote firmware changed; reconnect and replan` | Remote auto-updated. Rerun `connect <name> --host ...` (keeps credentials), then plan.                                                                                                  |
| `transport failed` / timeouts                   | Remote asleep (wake it) or no LAN access from this machine.                                                                                                                             |
| Uncertain writes after a crash                  | Run `resume`. Never blindly rerun apply; use `state adopt KEY ID` if a create actually succeeded.                                                                                       |

`npm run uc -- api GET <path>` makes a raw authenticated Core API read (output
redacted). Non-GET methods require `--write` and should only be used for the
targeted repairs above.

Exit codes: `0` ok, `1` error, `2` drift/conflicts/deferred work/diagnose
findings, `3` paused waiting for a human step (setup or pairing).

## Integration Manager

Some things cannot be done through uc-config alone and need the community
[**UC Integration Manager**](https://github.com/JackJPowell/uc-intg-manager)
(runs on the remote at `http://<REMOTE_IP>:9999` while docked, or in Docker):

- **Installing custom/community integrations** (Kaleidescape, Oppo, Onkyo/Integra,
  Lutron, Kodi, etc.) from the community registry or a GitHub release. uc-config
  can register an external driver (`driver()`) or upload a local archive
  (`driverArchive()`), but it does not browse, download or version community
  integrations.
- **Updating integrations**, selecting versions, and rolling back.
- **Backing up integration configuration** (driver setup data the Core API does
  not export; `import` cannot recover these).
- **UI diagnostics**: orphaned entities, orphaned IR codesets and unused
  activity entities, plus integration logs.

Recommended split: install and update integrations with the Integration Manager,
then let uc-config own everything that _uses_ them (entities, activities,
buttons, pages, macros).

> **Integration updates can drop configured entities**, even when the manager
> says configuration is preserved. Every activity using them becomes orphaned.
> Keep the manager's _Auto update_ setting off, and after every integration
> update run:
>
> ```sh
> npm run uc -- diagnose && npm run uc -- plan
> ```
>
> Updates marked as _not preserving configuration_ additionally require
> re-running that integration's setup.

## Keeping your config private

The public repo holds the tool. Your configuration should live elsewhere:

```sh
mkdir ~/my-remote && cd ~/my-remote
npm init -y && npm pkg set type=module
npm install /path/to/uc-config         # or a git URL
npx uc-config connect living-room --host http://<REMOTE_IP>
# ...same runbook as above, using `npx uc-config` instead of `npm run uc --`
git init                               # private repo; add .uc/ to .gitignore
```

Alternatively, use `--workspace <dir>` to point the CLI at any directory holding
`remote.config.ts` and `.uc/`. Back up `.uc/state` and `.uc/journals`
privately; losing them makes the next plan an adoption pass.

## Reference

- [AGENTS.md](AGENTS.md): rules for coding agents working with this repo
- [docs/snippets.md](docs/snippets.md): common tasks as copy-paste recipes
- [docs/configuration-authoring.md](docs/configuration-authoring.md): config syntax, ownership, helpers
- [docs/cli.md](docs/cli.md): every CLI command, provisioning, recovery
- [examples/full-setup.ts](examples/full-setup.ts): integrations, docks, IR/BT remotes, pairing, profiles
- [remote.config.example.ts](remote.config.example.ts): minimal starter config
- [DESIGN.md](DESIGN.md): architecture and design rationale

## Development

```sh
npm run check          # typecheck
npm test               # build + test against a mock Core API
npm run format         # prettier
npm run generate       # regenerate wire types from vendor/core-api.json
```

Source lives in `src/`. The pinned upstream API specification and its license
are described in [vendor/README.md](vendor/README.md).

## License

MIT, see [LICENSE](LICENSE). The vendored Core API specification is CC-BY-SA-4.0.
Not affiliated with Unfolded Circle.
