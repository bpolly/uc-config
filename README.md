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

## Quick start (for humans)

### 1. Before you start

- Install [Node.js](https://nodejs.org/) 22 or newer.
- On the remote, enable the web configurator: **Settings → Profile → Web
  configurator**. Note the **PIN** it shows.
- Find the remote's **IP address**. It's shown in the remote's network
  settings, or in your router's device list. The computer you use must be on
  the same network as the remote.
- **Dock the remote** (or keep picking it up) during setup. It doesn't need the
  dock to work, but it goes to sleep when idle and drops off Wi-Fi, which
  interrupts setup. The Integration Manager's web page is also only available
  while docked.

### 2. Create your config folder

```sh
mkdir my-remote && cd my-remote
npx uc-config init
npm install
```

`init` creates the project files, then asks for the remote's IP address and
the web configurator PIN. The PIN is typed hidden in your terminal and is only
used once, to create an API key saved in `.uc/credentials.json`. Press Enter at
either prompt to skip it; you can rerun `npx uc-config init` at any time and it
picks up where it left off without overwriting anything.

If `init` says a key named `uc-config` already exists, revoke that key in the
web configurator and run `npx uc-config init` again.

This folder holds your remote's configuration. It's yours, not part of this
repo.

### 3. Let your coding agent set it up

Start your coding agent (Claude Code, Codex, Cursor, etc.) in that folder and
prompt:

> Set up my Remote 3

`init` already saved the remote's address, so you don't need to repeat it. (If
you skipped the IP prompt, include it: "Set up my Remote 3 at 192.168.1.50".)

The agent imports your current setup into `remote.config.ts` and records which
resources it manages. This writes nothing to the remote.

If you skipped the PIN during `init`, the agent will ask you to run
`npx uc-config auth` in your own terminal. **Don't paste the PIN into the
chat.**

`init` also writes `CLAUDE.md`, which points Claude Code at `AGENTS.md`;
Claude Code reads `CLAUDE.md` rather than `AGENTS.md`.

### 4. Save your config

Commit the folder to a **private** git repo. It contains your device IDs and
IP addresses. `.uc/` (credentials and state) is already gitignored; back it up
separately.

### Day to day

Ask your agent for changes in plain language, for example:

> Make the NEXT button skip chapters in the movie activity

> Add a page to Watch TV with buttons for Netflix and YouTube

> Something on the remote says "orphaned entity". Fix it.

The agent shows a plan of what will change before applying it. After you update
an integration in the Integration Manager, ask the agent to run diagnostics.

## Multiple remotes

Use **one folder per remote**:

```sh
mkdir -p remotes/living-room && cd remotes/living-room && npx uc-config init
mkdir -p remotes/bedroom && cd remotes/bedroom && npx uc-config init
```

Each folder has its own `remote.config.ts`, state and API key, and an agent
working in one folder can't touch the other remote. The folders can share one
private git repo. Two remotes rarely have identical configs, because entity IDs
include each remote's integration IDs; to share a macro or layout, put it in a
common `.ts` file and import it, using each folder's own `generated/devices.ts`
for the IDs.

`init` refuses to add a second remote to a folder that already has one.

## Updating

Ask your agent to "update uc-config", or run in your config folder:

```sh
npm install uc-config@latest
npx uc-config init --refresh-docs     # refresh AGENTS.md / CLAUDE.md
npx uc-config compile && npx uc-config plan    # must show 0 operations
```

Use `npm install uc-config@latest` rather than `npm update`: before 1.0,
`npm update` doesn't move between minor versions (0.2 → 0.3). `--refresh-docs`
keeps files you've edited and writes the new version beside them as `.new`.
`doctor` tells you when a newer version is available. See
[CHANGELOG.md](CHANGELOG.md) for what changed and whether a release needs any
action.

## Requirements

- Node.js 22+ and npm
- A Remote 3 on the same LAN, with the **web configurator enabled**
  (Settings → Profile → Web configurator) and its PIN
- Optional but recommended: the [UC Integration Manager](#integration-manager)

Tested against Remote 3 core `0.81.x`, API `0.19.0`. Firmware changes are detected
and block writes until you reconnect.

## Setup (agent runbook)

Run these in the config workspace (the folder created by `init`) using
`npx uc-config`, or from a clone of this repo using `npm run uc --`, as below.
Each step is idempotent or fails safely.

```sh
# 1. Install and build the CLI (dist/ is required by remote.config.ts imports)
npm install
npm run build
npm test                                   # offline, uses a mock Core API

# Steps 2-3 are usually already done by `npx uc-config init`. Skip them if
# .uc/targets/*.json and .uc/credentials.json exist.

# 2. Register the remote under a target name ("home" here). With a single
#    target, later commands pick it automatically; otherwise pass --target.
npm run uc -- connect home --host http://<REMOTE_IP>

# 3. Authenticate. Prompts for the web-configurator PIN in a TTY.
#    Headless agents: have the user run this step, or pass UC_PIN in the env.
#    Never write the PIN or key into files or chat logs.
npm run uc -- auth

# 4. Verify connectivity and API coverage
npm run uc -- doctor

# 5. Import and take ownership (local only; writes nothing to the remote).
#    Writes remote.config.ts and generated/devices.ts, and adopts everything.
npm run uc -- sync
npm run uc -- diagnose                        # health check

# 6. Confirm convergence
npm run uc -- compile
npm run uc -- check                           # 0 operations, 0 conflicts
```

After step 6 the workspace is ready. Every later change follows the edit loop below.

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

The remote is the source of truth and this folder is a working copy, so pull
first: `sync` brings in anything changed on the remote since the last run.

```sh
npm run uc -- sync              # pull remote edits; keeps your unapplied edits
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

**If the plan touches things you didn't edit, stop.** Those operations are
earlier source changes that were never applied, or edits made on the remote
since. Don't apply them along with your change: run `sync` first
(see [Pull changes made in the web configurator](docs/snippets.md#pull-changes-made-in-the-web-configurator)),
then replan until only your change is left.

**The plan output shortens long sequences.** To see the exact step-by-step
change, compare each operation's `before` with its `desired` in `.uc/plan.json`:

```sh
jq '.operations[] | {key, action, before, desired}' .uc/plan.json
```

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

| Message                                          | Meaning and fix                                                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Drift at <fields>`                              | Someone (or a driver update) changed an owned field on the remote. Copy the live value into source, or rerun `plan --overwrite-drift` only if the user wants the source value restored.            |
| `Managed resource disappeared`                   | Resource was deleted on the remote. Run `diagnose`; re-add or remove from source.                                                                                                                  |
| `Cannot verify command`                          | `cmd_id` isn't advertised by that entity, or the entity isn't in the activity's `entity_ids`. Check `generated/devices.ts`, refresh inventory.                                                     |
| `Remote firmware changed; reconnect and replan`  | Remote auto-updated. Rerun `connect <name> --host ...` (keeps credentials), then plan.                                                                                                             |
| `transport failed` / timeouts                    | Remote asleep, or this machine has no LAN access. Ping the router and another LAN device: if they fail too, it's this machine (on macOS, Local Network privacy), and waking the remote won't help. |
| `deferred ...: apply prerequisites, then replan` | The item depends on another change in the same plan (e.g. a new entity in `entity_ids`). Apply the plan, then plan again for the deferred items.                                                   |
| Uncertain writes after a crash                   | Run `resume`. Never blindly rerun apply; use `state adopt KEY ID` if a create actually succeeded.                                                                                                  |

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
> update run this in your config workspace:
>
> ```sh
> npx uc-config diagnose && npx uc-config plan
> ```
>
> (From a clone of this repo, use `npm run uc -- diagnose && npm run uc -- plan`.)
>
> Updates marked as _not preserving configuration_ additionally require
> re-running that integration's setup.

## Keeping your config private

This repo holds the tool. Your configuration belongs in its own folder, made
with `npx uc-config init` (see [Quick start](#quick-start)), in a **private**
git repo. `init` gitignores `.uc/`, which holds credentials.

Alternatively, use `--workspace <dir>` to point the CLI at any directory holding
`remote.config.ts` and `.uc/`. Nothing here is irreplaceable: the remote holds
the configuration, and if `.uc/state` or `remote.config.ts` is lost, `sync`
rebuilds both from it. Git is useful as a history of changes, not as a backup.

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
