import type { CoreClient } from "./client.js";
import type { ObjectValue } from "./model.js";
import { isObject } from "./util.js";

export interface Orphan {
  /** Entity ID that is referenced but no longer configured on the remote. */
  entityId: string;
  /** Activities/macros (by ID and display name) that still reference it. */
  usedBy: { id: string; name: string; kind: "activity" | "macro" }[];
  integrationId?: string;
  integrationState?: string;
  /** Integration-local ID (entity ID minus the `<integration>.` prefix). */
  localId?: string;
  /** The integration still offers this exact entity: it only needs re-adding. */
  readdable: boolean;
  /** Not-yet-configured entities of the same integration and type: likely re-keys. */
  candidates: { localId: string; entityId: string; name: string }[];
  fix: string;
}
export interface Diagnosis {
  orphans: Orphan[];
  integrations: { id: string; state: string }[];
  problems: string[];
}

const label = (v: unknown): string =>
  isObject(v)
    ? String(v.en ?? v.en_US ?? Object.values(v)[0] ?? "")
    : String(v ?? "");

/** Collect every entity ID referenced anywhere in a resource's options. */
export function referencedEntities(value: unknown, out = new Set<string>()) {
  if (Array.isArray(value)) for (const x of value) referencedEntities(x, out);
  else if (isObject(value))
    for (const [k, v] of Object.entries(value)) {
      if (k === "entity_id" && typeof v === "string") {
        out.add(v);
      } else if (k === "entity_ids" && Array.isArray(v)) {
        for (const x of v) if (typeof x === "string") out.add(x);
      } else {
        referencedEntities(v, out);
      }
    }
  return out;
}

/**
 * Read-only health check: finds entity references in activities and macros
 * that no longer resolve (typically after an integration update or re-key),
 * then works out the most likely repair for each.
 */
export async function diagnose(client: CoreClient): Promise<Diagnosis> {
  const entities = await client.list("/entities");
  const instances = await client.list("/intg/instances");
  const known = new Set(entities.map((e) => String(e.entity_id)));
  const owners = new Map<string, Orphan["usedBy"]>();
  for (const [kind, path] of [
    ["activity", "/activities"],
    ["macro", "/macros"],
  ] as const) {
    for (const summary of await client.list(path)) {
      const id = String(summary.entity_id);
      known.add(id);
      const detail = await client.get(`${path}/${encodeURIComponent(id)}`);
      for (const ref of referencedEntities(detail.options)) {
        const list = owners.get(ref) ?? [];
        list.push({ id, name: label(detail.name), kind });
        owners.set(ref, list);
      }
    }
  }
  const available = new Map<string, ObjectValue[]>();
  const availableFor = async (intg: string) => {
    if (!available.has(intg))
      available.set(
        intg,
        await client
          .list(
            `/intg/instances/${encodeURIComponent(intg)}/entities?filter=ALL`,
          )
          .catch(() => []),
      );
    return available.get(intg)!;
  };
  const orphans: Orphan[] = [];
  for (const [entityId, usedBy] of [...owners].sort()) {
    if (known.has(entityId)) continue;
    const instance = instances
      .filter((i) => entityId.startsWith(`${i.integration_id}.`))
      .sort(
        (a, b) =>
          String(b.integration_id).length - String(a.integration_id).length,
      )[0];
    const orphan: Orphan = {
      entityId,
      usedBy,
      readdable: false,
      candidates: [],
      fix: "",
    };
    orphans.push(orphan);
    if (!instance) {
      orphan.fix =
        "No installed integration owns this ID. Reinstall/set up the integration (see Integration Manager), or remove the reference from remote.config.ts.";
      continue;
    }
    const intg = String(instance.integration_id);
    orphan.integrationId = intg;
    orphan.integrationState = String(instance.device_state ?? "UNKNOWN");
    orphan.localId = entityId.slice(intg.length + 1);
    const offered = await availableFor(intg);
    orphan.readdable = offered.some((e) => e.entity_id === orphan.localId);
    if (orphan.readdable) {
      orphan.fix = `Re-add the entity: npm run uc -- api POST '/intg/instances/${intg}/entities/${orphan.localId}' --data '{}' --write`;
      continue;
    }
    const type = orphan.localId.split(".")[0];
    orphan.candidates = offered
      .filter(
        (e) =>
          !known.has(`${intg}.${e.entity_id}`) &&
          (!type ||
            String(e.entity_id).startsWith(`${type}.`) ||
            e.entity_type === type),
      )
      .map((e) => ({
        localId: String(e.entity_id),
        entityId: `${intg}.${e.entity_id}`,
        name: label(e.name),
      }));
    orphan.fix =
      orphan.integrationState !== "CONNECTED"
        ? `Integration ${intg} is ${orphan.integrationState}; reconnect it first, then rerun diagnose.`
        : orphan.candidates.length
          ? "Entity was likely re-keyed by a driver update. Re-add the matching candidate, then replace the old ID everywhere in remote.config.ts and plan."
          : "The integration no longer offers this entity. Re-run the integration's setup (web configurator or Integration Manager), or remove the reference.";
  }
  const integrations = instances.map((i) => ({
    id: String(i.integration_id),
    state: String(i.device_state ?? "UNKNOWN"),
  }));
  const problems = integrations
    .filter((i) => i.state !== "CONNECTED")
    .map((i) => `Integration ${i.id} is ${i.state}`);
  return { orphans, integrations, problems };
}

export function formatDiagnosis(d: Diagnosis): string {
  const lines: string[] = [];
  for (const o of d.orphans) {
    lines.push(`ORPHAN ${o.entityId}`);
    lines.push(
      `  used by: ${o.usedBy.map((u) => `${u.kind} "${u.name}" (${u.id})`).join(", ")}`,
    );
    if (o.integrationId)
      lines.push(`  integration: ${o.integrationId} [${o.integrationState}]`);
    for (const c of o.candidates)
      lines.push(`  candidate: ${c.entityId} "${c.name}"`);
    lines.push(`  fix: ${o.fix}`);
  }
  for (const p of d.problems) lines.push(`WARN ${p}`);
  lines.push(
    d.orphans.length || d.problems.length
      ? `${d.orphans.length} orphaned entity reference(s), ${d.problems.length} integration problem(s).`
      : `All clear: ${d.integrations.length} integrations connected, no orphaned entity references.`,
  );
  return lines.join("\n");
}
