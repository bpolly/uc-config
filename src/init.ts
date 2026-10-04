import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const agents = (version: string) => `# Remote 3 configuration (uc-config)

This folder holds the user's Unfolded Circle Remote 3 configuration. It is
managed with the \`uc-config\` CLI (v${version}). Reference docs ship with the package:

- node_modules/uc-config/README.md: setup, diagnostics, Integration Manager
- node_modules/uc-config/docs/snippets.md: recipes for common tasks (start here)
- node_modules/uc-config/docs/cli.md: every command, recovery
- node_modules/uc-config/docs/configuration-authoring.md: config syntax and ownership

## First run (no .uc/targets/ yet)

1. \`npx uc-config connect home --host http://<IP>\`. Ask the user for the IP if not given.
2. Ask the user to run \`npx uc-config auth\` in their own terminal (the web
   configurator must be enabled on the remote). Never ask for the PIN in chat.
3. \`npx uc-config doctor\`
4. \`npx uc-config inventory --bindings generated/devices.ts\`
5. \`npx uc-config import --out remote.config.ts\`
6. \`npx uc-config compile && npx uc-config plan --out .uc/plan.json\`. Expect only \`= adopt\` operations.
7. \`npx uc-config apply .uc/plan.json --adopt-only && npx uc-config check\`
8. \`git init && git add -A && git commit -m "Import Remote 3 config"\`

If \`.uc/\` already exists, reuse it. Don't re-auth, re-import or re-adopt.

## Every change

Edit remote.config.ts, then: \`npx tsc --noEmit\`, \`npx uc-config compile\`,
\`npx uc-config plan --out .uc/plan.json\`, review, \`npx uc-config apply .uc/plan.json\`,
\`npx uc-config check\` (must be 0 operations).

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

## Upgrading the tool

\`npm update uc-config\`, then compile and plan. The plan must show 0 operations
before you make any other change.
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
}

/** Scaffold a private config workspace. Never overwrites existing files. */
export async function init(dir: string, version: string): Promise<InitResult> {
  await mkdir(dir, { recursive: true });
  const result: InitResult = {
    written: [],
    skipped: [],
    packageJsonUpdated: false,
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
  await put("AGENTS.md", agents(version));
  return result;
}
