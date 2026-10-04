# Local state that git does not hold

Your remote's configuration and operating state are deliberately kept out of
this repository. A fresh clone contains the tool only.

| Path                   | Contents                                                     | Back up?                  |
| ---------------------- | ------------------------------------------------------------ | ------------------------- |
| `remote.config.ts`     | Your desired configuration                                   | Yes (private git repo)    |
| `generated/devices.ts` | Entity/command bindings from `inventory --bindings`          | Optional (regenerable)    |
| `.uc/targets/`         | Remote address, identity and firmware                        | Yes                       |
| `.uc/credentials.json` | API key (mode 0600)                                          | No; re-run `auth` if lost |
| `.uc/state/`           | Logical key → remote ID bindings and the last applied values | **Yes, critical**         |
| `.uc/journals/`        | Apply journals used by `resume` and `rollback`               | Yes                       |
| `.uc/*.json`           | Builds, plans, inventories                                   | No                        |

If you lose `.uc/state`, the next plan becomes an adoption pass. Recreate it
with `import`, review the result, and then `apply --adopt-only`. Never apply a
plan that unexpectedly creates resources which already exist on the remote.

When you move to a new machine, copy `.uc/` across (e.g. `rsync -a old/.uc/ new/.uc/`)
rather than re-running `connect`/`auth`/`import`. A new session or new clone
should reuse existing state, not start over.

For the full first-run procedure see the README's "Setup (agent runbook)".
