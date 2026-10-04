import { route, importShape } from "./adapter.js";
import { ApiError, CoreClient } from "./client.js";
import type { Config, ObjectValue, Resource } from "./model.js";
import { isObject, secretFields } from "./util.js";
import { writable } from "./schema.js";
export interface Inventory {
  version: unknown;
  collections: Record<string, ObjectValue[]>;
  settings: Record<string, ObjectValue>;
  unsupported: string[];
}
export async function inventory(client: CoreClient): Promise<Inventory> {
  const result: Inventory = {
    version: await client.version(),
    collections: {},
    settings: {},
    unsupported: [],
  };
  for (const [name, path, field] of [
    ["entities", "/entities", "entity_id"],
    ["activities", "/activities", "entity_id"],
    ["macros", "/macros", "entity_id"],
    ["profiles", "/profiles", "profile_id"],
    ["activityGroups", "/activity_groups", "group_id"],
    ["drivers", "/intg/drivers", "driver_id"],
    ["integrations", "/intg/instances", "integration_id"],
    ["docks", "/docks", "dock_id"],
    ["irRemotes", "/remotes?kind=IR", "entity_id"],
    ["btRemotes", "/remotes?kind=BT", "entity_id"],
    ["externalRemotes", "/remotes?kind=EXTERNAL", "entity_id"],
  ] as const) {
    try {
      const list = await client.list(path);
      const base = name === "docks" ? "/docks/devices" : path.split("?")[0];
      result.collections[name] = await Promise.all(
        list.map((x) =>
          client.get(`${base}/${encodeURIComponent(String(x[field]))}`),
        ),
      );
    } catch (e) {
      if (e instanceof ApiError && [404, 405].includes(e.status))
        result.unsupported.push(path);
      else throw e;
    }
  }
  for (const section of [
    "device",
    "display",
    "button",
    "haptic",
    "localization",
    "power_saving",
    "sound",
    "bt",
    "profile",
    "voice_control",
  ]) {
    try {
      result.settings[section] = await client.get(`/cfg/${section}`);
    } catch (e) {
      if (e instanceof ApiError && [404, 405].includes(e.status))
        result.unsupported.push(`/cfg/${section}`);
      else throw e;
    }
  }
  return result;
}
/** Display name from a string or a localized {en: ...} map. */
function nameOf(item: unknown): string | undefined {
  const n = isObject(item) ? item.name : undefined;
  if (typeof n === "string") return n;
  if (isObject(n)) {
    const v = n.en ?? Object.values(n).find((x) => typeof x === "string");
    if (typeof v === "string") return v;
  }
  return undefined;
}
/** snake_case key segment; falls back to the id when the name has no letters/digits. */
export function slug(name: string | undefined, fallback: string): string {
  const s = (x: string) =>
    x
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  return s(name ?? "") || s(fallback) || "item";
}
export async function importConfig(
  client: CoreClient,
): Promise<{ config: Config; warnings: string[] }> {
  const inv = await inventory(client);
  const resources: Record<string, Resource> = {};
  const warnings = [...inv.unsupported.map((p) => `Unsupported endpoint ${p}`)];
  // Readable keys from display names ("Play PS5" -> activity.play_ps5);
  // collisions get _2, _3, ... in import order.
  const add = (r: Resource, base: string) => {
    let key = base;
    for (let n = 2; key in resources; n++) key = `${base}_${n}`;
    resources[key] = r;
    return key;
  };
  for (const [collection, kind, field] of [
    ["activities", "activity", "entity_id"],
    ["macros", "macro", "entity_id"],
    ["profiles", "profile", "profile_id"],
    ["activityGroups", "activityGroup", "group_id"],
    ["integrations", "integration", "integration_id"],
    ["docks", "dock", "dock_id"],
    ["irRemotes", "remote", "entity_id"],
    ["btRemotes", "remote", "entity_id"],
    ["externalRemotes", "remote", "entity_id"],
  ] as const) {
    for (const item of inv.collections[collection] ?? []) {
      const id = String(item[field]);
      const r: Resource = { kind, id, data: {} };
      const rt = route(r, id);
      r.data = writable(rt.itemTemplate, "patch", importShape(r, item));
      if (kind === "integration")
        r.data = { name: item.name!, driver_id: item.driver_id! };
      if (kind === "dock")
        r.data = Object.fromEntries(
          Object.entries(r.data).filter(
            ([k]) => !["token", "wifi"].includes(k),
          ),
        );
      const secrets = secretFields(r.data);
      if (secrets.length) {
        warnings.push(
          `${id}: secret-bearing settings require manual secret() references`,
        );
        continue;
      }
      const key = add(r, `${kind}.${slug(nameOf(item), id)}`);
      if (kind === "integration" || kind === "dock")
        warnings.push(
          `${key}: existing resource imported; supply create/setup inputs and secret references to reproduce on a new target`,
        );
      if (kind === "remote" && collection !== "externalRemotes")
        warnings.push(
          `${key}: add creation parameters from inventory for fresh-target provisioning; Bluetooth pairings require pairing steps`,
        );
      if (kind === "activity" || kind === "remote") {
        const prefix = kind === "activity" ? "activities" : "remotes";
        try {
          const buttons = await client.get<unknown>(
            `/${prefix}/${encodeURIComponent(id)}/buttons`,
          );
          if (!Array.isArray(buttons))
            throw new Error("Unexpected button list");
          for (const b of buttons.filter(isObject))
            for (const press of ["short_press", "long_press"])
              if (isObject(b[press]))
                add(
                  {
                    kind:
                      kind === "activity" ? "activityButton" : "remoteButton",
                    parent: { $ref: key },
                    id: `${b.button}/${press}`,
                    data: { [press]: b[press]! },
                  },
                  `${key}.button.${slug(String(b.button), "button")}_${press}`,
                );
          const pages = await client.list(
            `/${prefix}/${encodeURIComponent(id)}/ui/pages`,
          );
          for (const p of pages)
            add(
              {
                kind: kind === "activity" ? "activityPage" : "remotePage",
                parent: { $ref: key },
                id: String(p.page_id),
                data: writable(
                  `/${prefix}/{entityId}/ui/pages/{pageId}`,
                  "patch",
                  p,
                ),
              },
              `${key}.page.${slug(nameOf(p), String(p.page_id))}`,
            );
        } catch (e) {
          if (e instanceof ApiError && [404, 405].includes(e.status))
            warnings.push(
              `${key}: button/page endpoints unavailable; customization not imported`,
            );
          else throw e;
        }
      }
      if (kind === "profile")
        for (const child of ["pages", "groups"]) {
          const list = await client.list(
            `/profiles/${encodeURIComponent(id)}/${child}`,
          );
          for (const c of list) {
            const group = child === "groups";
            add(
              {
                kind: group ? "profileGroup" : "profilePage",
                parent: { $ref: key },
                id: String(c[group ? "group_id" : "page_id"]),
                data: writable(
                  `/profiles/{profileId}/${child}/{${group ? "groupId" : "pageId"}}`,
                  "patch",
                  c,
                ),
              },
              `${key}.${group ? "group" : "page"}.${slug(nameOf(c), String(c[group ? "group_id" : "page_id"]))}`,
            );
          }
        }
      if (collection === "irRemotes") {
        const ir = await client.get(`/remotes/${encodeURIComponent(id)}/ir`);
        if (Array.isArray(ir.codes))
          for (const code of ir.codes.filter(isObject))
            if (
              typeof code.cmd_id === "string" &&
              isObject(code.code) &&
              code.code.value &&
              code.code.format
            )
              add(
                {
                  kind: "irCode",
                  parent: { $ref: key },
                  id: code.cmd_id,
                  data: {
                    format: (code.code as ObjectValue).format!,
                    value: (code.code as ObjectValue).value!,
                  },
                },
                `${key}.ir.${slug(code.cmd_id, "code")}`,
              );
      }
    }
  }
  for (const item of inv.collections.entities ?? []) {
    if (
      ["activity", "macro", "remote"].includes(String(item.entity_type)) ||
      typeof item.integration_id !== "string" ||
      !item.integration_id
    )
      continue;
    add(
      {
        kind: "entity",
        id: String(item.entity_id),
        parent: item.integration_id,
        data: writable("/entities/{entityId}", "patch", item),
      },
      `entity.${slug(nameOf(item), String(item.entity_id))}`,
    );
  }
  const usedDrivers = new Set(
    (inv.collections.integrations ?? []).map((i) => i.driver_id),
  );
  for (const item of inv.collections.drivers ?? []) {
    if (!usedDrivers.has(item.driver_id)) continue;
    const data = writable("/intg/drivers/{driverId}", "patch", item);
    // Credentials returned by the API must never be exported into source.
    delete data.token;
    if (secretFields(data).length) {
      warnings.push(
        `${item.driver_id}: driver settings contain secrets; provide secret references manually`,
      );
      continue;
    }
    add(
      { kind: "driver", id: String(item.driver_id), data },
      `driver.${slug(nameOf(item), String(item.driver_id))}`,
    );
  }
  for (const [section, data] of Object.entries(inv.settings)) {
    const picked = writable(`/cfg/${section}`, "patch", data);
    if (
      section === "voice_control" &&
      isObject(picked.voice_assistant) &&
      Object.keys(picked.voice_assistant).length === 0
    ) {
      delete picked.voice_assistant;
      warnings.push(
        "voice_control: disabled assistant has no writable entity_id; its empty read-only representation is preserved but not owned.",
      );
    }
    if (!Object.keys(picked).length) continue;
    if (!secretFields(picked).length)
      add(
        { kind: "settings", id: section, data: picked },
        `settings.${section}`,
      );
    else
      warnings.push(
        `${section}: secret-bearing settings omitted; configure secret references`,
      );
  }
  warnings.push(
    "Imported arrays (page items, sequences, membership) are owned as whole fields. Review before adoption.",
  );
  warnings.push(
    "Driver installation archives, external-service deployment and binary assets cannot be reconstructed from this import; declare their local artifacts separately.",
  );
  return { config: { schemaVersion: 1, resources }, warnings };
}
export function generateBindings(inv: Inventory): string {
  const entities = inv.collections.entities ?? [];
  const ids = entities.map((e) => String(e.entity_id));
  const entries = entities.map((e, i) => {
    const detail = [...(inv.collections.activities ?? [])]
      .flatMap((a) =>
        isObject(a.options) && Array.isArray(a.options.included_entities)
          ? a.options.included_entities.filter(isObject)
          : Array.isArray(a.entities)
            ? a.entities.filter(isObject)
            : [],
      )
      .find((x) => x.entity_id === e.entity_id);
    const commands = [
      ...(Array.isArray(detail?.entity_commands) ? detail.entity_commands : []),
      ...(Array.isArray(detail?.simple_commands) ? detail.simple_commands : []),
      ...(isObject(e.options) && Array.isArray(e.options.simple_commands)
        ? e.options.simple_commands
        : []),
    ]
      .map((c) =>
        typeof c === "string"
          ? c
          : isObject(c)
            ? String(c.cmd_id ?? c.id ?? "")
            : "",
      )
      .filter(Boolean);
    return `  entity${i + 1}: { id: ${JSON.stringify(e.entity_id)}, name: ${JSON.stringify(e.name)}, commands: ${JSON.stringify([...new Set(commands)])} },`;
  });
  return `// Generated from remote inventory. Exact command IDs; rename aliases as needed.\nexport const devices = {\n${entries.join("\n")}\n} as const;\nexport type EntityId = ${ids.length ? ids.map((id) => JSON.stringify(id)).join(" | ") : "never"};\n`;
}
