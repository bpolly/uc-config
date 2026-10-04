import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const MARKER = /^<!-- uc-config:generated v(\S+) sha256:([0-9a-f]{64}) -->\n/;
/** Prefix generated docs with a marker so --refresh-docs can detect edits. */
const stamp = (version: string, body: string) =>
  `<!-- uc-config:generated v${version} sha256:${sha256(body)} -->\n${body}`;
/** Exact output of releases that predate the marker (0.1.0, 0.2.0). */
const LEGACY = new Set([
  "053dd83c530adb91f58ad52148c9d858cc28864a137b7b5e65c4563338e91b4f",
  "159e847a6a5b6c5cb9ed96f400e8f5d58cd9acae2e68bf666fc3fae2e4ad249b",
  "d71e02c349b769c916d166a6b26cc14d80da4142042fa90564bda85c897a9b07",
]);
/** True when the file is unedited generated output from any uc-config version. */
export function isPristine(content: string): boolean {
  const m = MARKER.exec(content);
  if (m) return sha256(content.slice(m[0].length)) === m[2];
  return LEGACY.has(sha256(content));
}

const agents = (version: string) => `# Remote 3 configuration (uc-config)

This folder holds the user's Unfolded Circle Remote 3 configuration. It is
managed with the \`uc-config\` CLI (v${version}). Reference docs ship with the package:

- node_modules/uc-config/README.md: setup, diagnostics, Integration Manager
- node_modules/uc-config/docs/snippets.md: recipes for common tasks (start here)
- node_modules/uc-config/docs/cli.md: every command, recovery
- node_modules/uc-config/docs/configuration-authoring.md: config syntax and ownership

## First run

\`npx uc-config init\` usually already connected and authenticated. Check what
exists, and skip steps that are done:

1. No \`.uc/targets/*.json\`: run \`npx uc-config connect home --host http://<IP>\`.
   Ask the user for the IP if not given.
2. No \`.uc/credentials.json\` (and no \`UC_API_KEY\` env): ask the user to run
   \`npx uc-config auth\` in their own terminal (the web configurator must be
   enabled on the remote). Never ask for the PIN in chat, and never run \`auth\`
   yourself; it needs a real terminal.
3. \`npx uc-config doctor\`
4. \`npx uc-config sync\`. With no remote.config.ts yet, it imports the remote,
   writes remote.config.ts and generated/devices.ts, and adopts everything. It
   never writes to the remote.
5. \`npx uc-config compile && npx uc-config check\` (must be 0 operations).
6. \`git init && git add -A && git commit -m "Import Remote 3 config"\`

If \`.uc/\` already exists, reuse it. Don't re-auth. If remote.config.ts or
\`.uc/state\` is lost, the remote still has everything: run sync again.

## Every change

The remote is the source of truth; this folder is a working copy of it.

1. \`npx uc-config sync\` first. It pulls edits made on the remote (web
   configurator, driver updates) into remote.config.ts and refreshes
   generated/devices.ts, keeping any unapplied local edits. If it reports a
   conflict (\`!\`), stop and ask the user which value to keep.
2. Edit remote.config.ts.
3. \`npx tsc --noEmit\`, \`npx uc-config compile\`,
   \`npx uc-config plan --out .uc/plan.json\`, review,
   \`npx uc-config apply .uc/plan.json\`, \`npx uc-config check\` (must be 0 operations).
4. Commit, so git keeps a history of what changed.

- Use only entity IDs and cmd_ids from generated/devices.ts or a fresh inventory.
  Never invent command names.
- A command must belong to an entity in the activity's/macro's \`entity_ids\`.
- Arrays (entity_ids, sequences, page items) are replaced whole: keep existing
  entries and order.
- Preserve resource keys and native \`id\`s. Never hand-edit files in .uc/.
- The plan must contain only the intended change. Anything else: stop and ask.
- Never use --overwrite-drift or --prune without the user's say-so.
- Never put secrets in remote.config.ts or print .uc/credentials.json.

## When something is broken

Run \`npx uc-config diagnose\`. It is read-only and prints a \`fix:\` per issue.
Re-adding a dropped entity the integration still offers is safe to do
directly. Ask before anything else. Integration installs and updates belong to
the UC Integration Manager (http://<remote>:9999); run diagnose after any update.

## Multiple remotes

This folder manages exactly one remote (one target in \`.uc/targets/\`). For
another remote, create a sibling folder and run \`npx uc-config init\` there.
Never connect a second remote here, and never copy \`.uc/\` between folders.
Shared pieces can be imported from a common .ts file, but entity IDs must come
from each folder's own generated/devices.ts.

## If the remote doesn't respond

\`transport failed\` or timeouts usually mean the remote went to sleep. Ask the
user to pick it up or dock it, then retry. Don't change the host.

## Upgrading the tool

1. \`npm install uc-config@latest\` (not \`npm update\`: it won't cross 0.x minor versions).
2. \`npx uc-config init --refresh-docs\` to update this file and CLAUDE.md.
   Files the user edited are kept; the new version is written beside them as \`.new\`.
3. Read node_modules/uc-config/CHANGELOG.md for any "Action required" notes.
4. \`npx uc-config compile && npx uc-config plan\`. It must show 0 operations
   before you make any other change. If not, the upgrade changed how the config
   is read: show the user the plan and don't apply it.
`;

// Claude Code reads CLAUDE.md, not AGENTS.md. Newer releases follow the
// @-import; the prose line covers releases that don't support imports.
const claude = `# Remote 3 configuration (uc-config)

Read AGENTS.md in this folder before doing anything. It is the authoritative
guide for working here: setup steps, editing rules and safety limits.

@AGENTS.md
`;

const tsconfig = {
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["remote.config.ts", "generated/**/*.ts"],
};

const gitignore = `node_modules/
# Credentials, state and journals. Back up .uc/state and .uc/journals privately.
.uc/
.env
.env.*
`;

export interface InitResult {
  written: string[];
  skipped: string[];
  packageJsonUpdated: boolean;
  /** Generated docs replaced by --refresh-docs. */
  refreshed: string[];
  /** Edited docs kept; the new version was written to `<name>.new`. */
  conflicts: string[];
}

/** Scaffold a private config workspace. Never overwrites existing files. */
export async function init(
  dir: string,
  version: string,
  options: { refreshDocs?: boolean } = {},
): Promise<InitResult> {
  await mkdir(dir, { recursive: true });
  const result: InitResult = {
    written: [],
    skipped: [],
    packageJsonUpdated: false,
    refreshed: [],
    conflicts: [],
  };
  const doc = async (name: string, contents: string) => {
    let existing: string | undefined;
    try {
      existing = await readFile(join(dir, name), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (existing === undefined) return put(name, contents);
    if (!options.refreshDocs || existing === contents)
      return void result.skipped.push(name);
    if (isPristine(existing)) {
      await writeFile(join(dir, name), contents);
      result.refreshed.push(name);
    } else {
      await writeFile(join(dir, `${name}.new`), contents);
      result.conflicts.push(name);
    }
  };
  const put = async (name: string, contents: string) => {
    try {
      await writeFile(join(dir, name), contents, { flag: "wx" });
      result.written.push(name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      result.skipped.push(name);
    }
  };
  const pkgPath = join(dir, "package.json");
  let pkg: Record<string, any> | undefined;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (!pkg) {
    await put(
      "package.json",
      JSON.stringify(
        {
          name: "my-remote",
          private: true,
          type: "module",
          dependencies: { "uc-config": `^${version}` },
          devDependencies: { typescript: "^5.9.3" },
        },
        null,
        2,
      ) + "\n",
    );
  } else if (
    !pkg.dependencies?.["uc-config"] &&
    !pkg.devDependencies?.["uc-config"]
  ) {
    pkg.dependencies = { ...pkg.dependencies, "uc-config": `^${version}` };
    if (!pkg.type) pkg.type = "module";
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    result.packageJsonUpdated = true;
  } else {
    result.skipped.push("package.json");
  }
  await put("tsconfig.json", JSON.stringify(tsconfig, null, 2) + "\n");
  await put(".gitignore", gitignore);
  await doc("AGENTS.md", stamp(version, agents(version)));
  await doc("CLAUDE.md", stamp(version, claude));
  return result;
}
