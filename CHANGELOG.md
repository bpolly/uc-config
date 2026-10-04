# Changelog

Each release says whether upgrading needs any **action**. To upgrade a config
workspace:

```sh
npm install uc-config@latest
npx uc-config init --refresh-docs
npx uc-config compile && npx uc-config plan   # must show 0 operations
```

## 0.2.4

Action required: none. Existing configs keep their keys.

- `import` builds readable keys from display names (`activity.play_ps5`,
  `activity.play_ps5.button.mute_short_press`, `entity.living_room_lamp`)
  instead of `activity8`. Duplicate names get `_2`, `_3`. To rename keys in an
  existing config, use `state move OLD NEW`.

## 0.2.3

Action required: none. Docs only.

- README: what to do when a plan contains operations you didn't make, how to
  read full sequence changes from `.uc/plan.json`, telling a sleeping remote
  from a machine without LAN access, and what `deferred` means.
- Snippets: corrected the entity-swap recipe. Swapped-in commands are deferred
  until the `entity_ids` change is applied, rather than failing with
  `Cannot verify command`.

## 0.2.2

Action required: optional. Run `npx uc-config init --refresh-docs` to get the
new AGENTS.md sections.

- Multiple remotes: documented as one folder per remote. `init` refuses to add
  a second remote to a folder, and commands that can't pick a target list the
  targets the folder has.
- `init` ends by suggesting the prompt "Set up my Remote 3" (the address is
  already saved).
- Docs: dock or wake the remote during setup; AGENTS.md says what to do when the
  remote stops responding.

## 0.2.1

Action required: run `npx uc-config init --refresh-docs`. It updates the
scaffolded AGENTS.md, whose upgrade instructions were wrong.

- `init --refresh-docs` updates AGENTS.md and CLAUDE.md to the installed
  version. Files you edited are kept, and the new version is written beside
  them as `.new`.
- `doctor` prints a notice when a newer version is published. Set
  `UC_NO_UPDATE_CHECK=1` to disable it.
- The scaffolded upgrade instructions use `npm install uc-config@latest`.
  `npm update` doesn't move between 0.x minor versions.

## 0.2.0

Action required: none.

- `init` asks for the remote's IP and the web configurator PIN, then connects
  and authenticates. It can be rerun safely.
- `init` writes CLAUDE.md, which points Claude Code at AGENTS.md.

## 0.1.0

First release.
