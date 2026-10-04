import type { Adapter } from "./adapter.js";
import type { Config, Json, ObjectValue, Resource, State } from "./model.js";
import { configurationView } from "./planner.js";
import { equal, get, isObject, leaves, merge, references } from "./util.js";

/**
 * What sync did (or would do) to one resource.
 *
 * - pull: changed on the remote, unchanged locally; source and baseline now match live.
 * - add: exists only on the remote; added to source and adopted.
 * - remove: deleted on the remote; removed from source and ownership dropped.
 * - local: unapplied local edit, remote unchanged; kept for the next plan.
 * - applied: the local edit is already live; baseline updated.
 * - conflict: changed both locally and on the remote; nothing touched.
 */
export interface SyncChange {
  key: string;
  action: "pull" | "add" | "remove" | "local" | "applied" | "conflict";
  fields?: string[];
  note?: string;
}
export interface SyncResult {
  config: Config;
  state: State;
  changes: SyncChange[];
}

/** Kinds that `import` reproduces, so their absence from an import means something. */
const IMPORTED = new Set<Resource["kind"]>([
  "activity",
  "macro",
  "profile",
  "profilePage",
  "profileGroup",
  "activityGroup",
  "activityPage",
  "remotePage",
  "activityButton",
  "remoteButton",
  "integration",
  "dock",
  "remote",
  "irCode",
  "entity",
  "driver",
  "settings",
]);

export function changedFields(a: ObjectValue, b: ObjectValue): string[] {
  const paths = new Map<string, string[]>();
  for (const [p] of [...leaves(a), ...leaves(b)]) paths.set(p.join("."), p);
  return [...paths]
    .filter(([, p]) => !equal(get(a, p), get(b, p)))
    .map(([name]) => name)
    .sort();
}

const identity = (kind: string, parent: string | undefined, id: string) =>
  JSON.stringify([kind, parent ?? "", id]);

/**
 * Three-way merge of the live remote into local source and state.
 *
 * `live` is a fresh `import` of the remote. Source resources are matched to live
 * ones by (kind, parent's native id, native id), never by logical key, so
 * hand-chosen keys survive. `confirmGone` re-reads a resource the import did not
 * return, so an endpoint the import skipped is never mistaken for a deletion.
 * Pure apart from `confirmGone`; never writes to the remote.
 */
export async function syncConfig(
  source: Config,
  state: State,
  live: Config,
  confirmGone: (key: string) => Promise<boolean>,
): Promise<SyncResult> {
  const config = structuredClone(source);
  const next = structuredClone(state);
  const changes: SyncChange[] = [];

  const sourceParent = (p: Resource["parent"]): string | undefined => {
    if (typeof p === "string") return p;
    if (isObject(p) && typeof p.$ref === "string")
      return next.bindings[p.$ref]?.id ?? config.resources[p.$ref]?.id;
    return undefined;
  };
  const sourceIndex = new Map<string, string>();
  for (const [key, r] of Object.entries(config.resources)) {
    const id = next.bindings[key]?.id ?? r.id;
    if (id) sourceIndex.set(identity(r.kind, sourceParent(r.parent), id), key);
  }

  const liveParent = (p: Resource["parent"]): string | undefined => {
    if (typeof p === "string") return p;
    if (isObject(p) && typeof p.$ref === "string")
      return live.resources[p.$ref]?.id;
    return undefined;
  };
  const liveToSource = new Map<string, string>();
  const seen = new Set<string>();

  for (const [liveKey, lr] of Object.entries(live.resources)) {
    if (!lr.id) continue;
    const ident = identity(lr.kind, liveParent(lr.parent), lr.id);
    seen.add(ident);
    const key = sourceIndex.get(ident);
    if (key) {
      liveToSource.set(liveKey, key);
      const s = config.resources[key]!;
      const binding = next.bindings[key];
      if (!binding) continue; // in source but never adopted: plan adopts it
      const S = s.data;
      const B = binding.baseline;
      const liveOwned = configurationView(lr.data, B, B);
      const sourceChanged = !equal(S, B);
      const liveChanged = !equal(liveOwned, B);
      if (!liveChanged) {
        if (sourceChanged)
          changes.push({ key, action: "local", fields: changedFields(B, S) });
        continue;
      }
      if (!sourceChanged) {
        changes.push({
          key,
          action: "pull",
          fields: changedFields(B, liveOwned),
        });
        s.data = liveOwned;
        binding.baseline = structuredClone(liveOwned);
        binding.resource = structuredClone(s);
        continue;
      }
      const liveWanted = configurationView(lr.data, merge(B, S), B);
      if (equal(liveWanted, S)) {
        changes.push({ key, action: "applied", fields: changedFields(B, S) });
        binding.baseline = structuredClone(S);
        binding.resource = structuredClone(s);
        continue;
      }
      changes.push({
        key,
        action: "conflict",
        fields: [
          ...new Set([...changedFields(B, S), ...changedFields(B, liveOwned)]),
        ].sort(),
        note: "changed locally and on the remote; resolve by hand",
      });
      continue;
    }
    // Only on the remote: add under the import's readable key, adopted as-is.
    let parent: Resource["parent"] = lr.parent;
    if (isObject(lr.parent) && typeof lr.parent.$ref === "string") {
      const mapped = liveToSource.get(lr.parent.$ref);
      if (!mapped) continue; // parent is in conflict or unmatched; skip child
      parent = { $ref: mapped };
    }
    let newKey = liveKey;
    for (let n = 2; newKey in config.resources; n++) newKey = `${liveKey}_${n}`;
    const r: Resource = {
      ...structuredClone(lr),
      ...(parent ? { parent } : {}),
    };
    config.resources[newKey] = r;
    next.bindings[newKey] = {
      id: lr.id,
      resource: structuredClone(r),
      baseline: structuredClone(lr.data),
    };
    liveToSource.set(liveKey, newKey);
    sourceIndex.set(ident, newKey);
    changes.push({ key: newKey, action: "add" });
  }

  // Owned resources the import no longer returns.
  const removed = new Set<string>();
  for (const [key, r] of Object.entries(config.resources)) {
    const binding = next.bindings[key];
    if (!binding || !IMPORTED.has(r.kind)) continue;
    if (seen.has(identity(r.kind, sourceParent(r.parent), binding.id)))
      continue;
    if (!(await confirmGone(key))) continue;
    if (!equal(r.data, binding.baseline)) {
      changes.push({
        key,
        action: "conflict",
        note: "deleted on the remote but has unapplied local edits",
      });
      continue;
    }
    removed.add(key);
  }
  // Children of a removed resource go with it.
  for (let grew = true; grew;) {
    grew = false;
    for (const [key, r] of Object.entries(config.resources))
      if (
        !removed.has(key) &&
        [...references(r), ...(r.dependsOn ?? [])].some((d) => removed.has(d))
      ) {
        removed.add(key);
        grew = true;
      }
  }
  for (const key of removed) {
    delete config.resources[key];
    delete next.bindings[key];
    changes.push({ key, action: "remove" });
  }

  if (!equal(next.bindings, state.bindings)) next.revision = state.revision + 1;
  return { config, state: next, changes };
}

/** confirmGone for syncConfig: true only when a direct read proves absence. */
export const remoteGone =
  (adapter: Adapter, state: State) =>
  async (key: string): Promise<boolean> => {
    const b = state.bindings[key];
    if (!b) return false;
    try {
      const obs = await adapter.observe(
        { ...b.resource, id: b.id },
        state,
        key,
      );
      return (
        obs.value === null ||
        (b.resource.kind.endsWith("Button") &&
          Object.keys(obs.value).length === 0)
      );
    } catch {
      return false; // can't prove it's gone; leave it alone
    }
  };

const HEADER = "import { defineRemote } from 'uc-config';\n\n";
/** Source text in the form `import` writes: plain JSON inside defineRemote(). */
export function renderSource(config: Config): string {
  return `${HEADER}export default defineRemote(${JSON.stringify(config, null, 2)});\n`;
}
/**
 * The config from an imported-form remote.config.ts, or null when the file uses
 * code (helpers, variables, imports) that sync can't rewrite without losing it.
 */
export function parseSource(text: string): Config | null {
  const m =
    /^\s*import\s*\{\s*defineRemote\s*\}\s*from\s*['"]uc-config['"];?\s*export\s+default\s+defineRemote\(([\s\S]*)\);?\s*$/.exec(
      text,
    );
  if (!m) return null;
  try {
    const value = JSON.parse(m[1]!) as Json;
    return isObject(value) && isObject(value.resources)
      ? (value as unknown as Config)
      : null;
  } catch {
    return null;
  }
}

export function formatSync(changes: SyncChange[]): string {
  const sign = {
    pull: "<",
    add: "+",
    remove: "-",
    local: "~",
    applied: "=",
    conflict: "!",
  } as const;
  const words = {
    pull: "pulled from remote",
    add: "added from remote",
    remove: "deleted on remote",
    local: "unapplied local edit kept",
    applied: "local edit already live",
    conflict: "conflict",
  } as const;
  const lines = changes.map(
    (c) =>
      `${sign[c.action]} ${c.key}: ${words[c.action]}${c.fields?.length ? ` (${c.fields.join(", ")})` : ""}${c.note ? `; ${c.note}` : ""}`,
  );
  const count = (a: SyncChange["action"]) =>
    changes.filter((c) => c.action === a).length;
  lines.push(
    `${count("pull")} pulled, ${count("add")} added, ${count("remove")} removed, ${count("local")} local edits kept, ${count("conflict")} conflicts`,
  );
  return lines.join("\n");
}
