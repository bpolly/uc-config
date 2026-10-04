import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { CoreClient } from "./client.js";
import type { ObjectValue, Resource, State, Observation } from "./model.js";
import { isObject, resolveRefs, hash } from "./util.js";
import { validateRequest } from "./schema.js";
import { verifyArtifact } from "./compiler.js";
export const ADAPTER = "ucr3-rest-04b0d08-v1";
const enc = (s: unknown) => encodeURIComponent(String(s));
export interface Route {
  collection: string;
  item: string;
  collectionTemplate: string;
  itemTemplate: string;
  idField: string;
  singleton?: boolean;
}
export function route(r: Resource, id?: string): Route {
  const parent = enc(r.parent);
  const itemId = enc(id ?? r.id ?? "");
  const simple: Partial<Record<Resource["kind"], [string, string, string]>> = {
    activity: ["/activities", "entityId", "entity_id"],
    macro: ["/macros", "entityId", "entity_id"],
    remote: ["/remotes", "entityId", "entity_id"],
    profile: ["/profiles", "profileId", "profile_id"],
    activityGroup: ["/activity_groups", "groupId", "group_id"],
    driver: ["/intg/drivers", "driverId", "driver_id"],
    integration: ["/intg/instances", "intgId", "integration_id"],
    entity: ["/entities", "entityId", "entity_id"],
    dock: ["/docks/devices", "dockId", "dock_id"],
    driverArchive: ["/intg/drivers", "driverId", "driver_id"],
  };
  const base = simple[r.kind];
  if (base)
    return {
      collection: base[0],
      item: `${base[0]}/${itemId}`,
      collectionTemplate: base[0],
      itemTemplate: `${base[0]}/{${base[1]}}`,
      idField: base[2],
    };
  if (
    ["activityPage", "remotePage", "profilePage", "profileGroup"].includes(
      r.kind,
    )
  ) {
    const profile = r.kind.startsWith("profile");
    const collection = `/${profile ? "profiles" : r.kind === "activityPage" ? "activities" : "remotes"}/${parent}/${profile ? (r.kind === "profileGroup" ? "groups" : "pages") : "ui/pages"}`;
    const template = `/${profile ? "profiles" : r.kind === "activityPage" ? "activities" : "remotes"}/{${profile ? "profileId" : "entityId"}}/${profile ? (r.kind === "profileGroup" ? "groups" : "pages") : "ui/pages"}`;
    const field = r.kind === "profileGroup" ? "group_id" : "page_id";
    return {
      collection,
      item: `${collection}/${itemId}`,
      collectionTemplate: template,
      itemTemplate: `${template}/{${field === "group_id" ? "groupId" : "pageId"}}`,
      idField: field,
    };
  }
  if (r.kind === "settings")
    return {
      collection: `/cfg/${r.id}`,
      item: `/cfg/${r.id}`,
      collectionTemplate: `/cfg/${r.id}`,
      itemTemplate: `/cfg/${r.id}`,
      idField: "id",
      singleton: true,
    };
  if (r.kind === "irCode")
    return {
      collection: `/remotes/${parent}/ir`,
      item: `/remotes/${parent}/ir/${itemId}`,
      collectionTemplate: "/remotes/{entityId}/ir",
      itemTemplate: "/remotes/{entityId}/ir/{cmdId}",
      idField: "id",
    };
  if (r.kind === "pairing")
    return {
      collection: `/remotes/${parent}/bt`,
      item: `/remotes/${parent}/bt/pairing`,
      collectionTemplate: "/remotes/{entityId}/bt",
      itemTemplate: "/remotes/{entityId}/bt/pairing",
      idField: "id",
      singleton: true,
    };
  if (r.kind === "activityButton" || r.kind === "remoteButton") {
    const prefix = r.kind === "activityButton" ? "activities" : "remotes";
    const button = enc((r.id ?? "").split("/")[0]);
    return {
      collection: `/${prefix}/${parent}/buttons`,
      item: `/${prefix}/${parent}/buttons/${button}`,
      collectionTemplate: `/${prefix}/{entityId}/buttons`,
      itemTemplate: `/${prefix}/{entityId}/buttons/{buttonId}`,
      idField: "button",
      singleton: true,
    };
  }
  if (r.kind === "asset")
    return {
      collection: `/resources/${enc(r.resourceType)}`,
      item: `/resources/${enc(r.resourceType)}/${itemId}`,
      collectionTemplate: "/resources/{type}",
      itemTemplate: "/resources/{type}/{id}",
      idField: "id",
    };
  throw new Error(`Unsupported resource kind ${r.kind}`);
}
export function desired(r: Resource): ObjectValue {
  return r.kind === "asset" || r.kind === "driverArchive"
    ? { sha256: r.sha256! }
    : r.data;
}
export function importShape(r: Resource, value: ObjectValue): ObjectValue {
  const v = structuredClone(value);
  if (
    ["activity", "macro"].includes(r.kind) &&
    isObject(v.options) &&
    !Array.isArray(v.options.entity_ids)
  ) {
    const included = Array.isArray(v.options.included_entities)
      ? v.options.included_entities
      : Array.isArray(v.entities)
        ? v.entities
        : [];
    v.options.entity_ids = included
      .filter(isObject)
      .map((e) => e.entity_id!)
      .filter(Boolean);
  }
  if (r.kind === "irCode" && isObject(v.code)) return v.code;
  return v;
}
export class Adapter {
  constructor(readonly client: CoreClient) {}
  private included?: Promise<Map<string, ObjectValue>>;
  private async includedEntity(id: string): Promise<ObjectValue | undefined> {
    this.included ??= (async () => {
      const found = new Map<string, ObjectValue>();
      for (const kind of ["activities", "macros"]) {
        for (const summary of await this.client.list(`/${kind}`)) {
          const item = await this.client.get(
            `/${kind}/${enc(String(summary.entity_id))}`,
          );
          const list =
            isObject(item.options) &&
            Array.isArray(item.options.included_entities)
              ? item.options.included_entities.filter(isObject)
              : [];
          for (const x of list)
            if (
              typeof x.entity_id === "string" &&
              Array.isArray(x.entity_commands) &&
              !found.has(x.entity_id)
            )
              found.set(x.entity_id, x);
        }
      }
      return found;
    })();
    return (await this.included).get(id);
  }
  async observe(
    original: Resource,
    state: State,
    key: string,
  ): Promise<Observation> {
    const r = resolveRefs(original, state);
    let id = state.bindings[key]?.id ?? r.id;
    if (r.kind === "asset" && !id)
      id = `uc-${r.sha256}${extname(r.file ?? "")}`;
    if (r.kind === "entity" && !id) {
      const matches = (await this.client.list("/entities")).filter(
        (e) =>
          e.integration_id === r.parent && e.entity_id === r.create?.entity_id,
      );
      if (matches.length > 1) throw new Error(`${key}: ambiguous entity`);
      if (matches.length) id = String(matches[0]!.entity_id);
    }
    const rt = route(r, id);
    if (r.kind === "asset") {
      const found = (await this.client.list(rt.collection)).find(
        (x) => x.id === id,
      );
      if (!found) return { resource: r, id, value: null };
      // Remote files are content-addressed by our upload name. Existing foreign files must be imported explicitly.
      if (!state.bindings[key] && !String(id).startsWith(`uc-${r.sha256}`))
        throw new Error(`${key}: asset identity cannot be verified`);
      const bytes = await this.client.download(route(r, id).item);
      return {
        resource: r,
        id,
        value: { sha256: createHash("sha256").update(bytes).digest("hex") },
      };
    }
    if (r.kind === "driverArchive") {
      const found = id ? await this.client.maybe(rt.item) : null;
      if (found && !state.bindings[key])
        throw new Error(
          `${key}: existing driver needs explicit inventory/adoption; cannot verify installed archive hash`,
        );
      return {
        resource: r,
        id,
        value: found ? { sha256: state.bindings[key]!.resource.sha256! } : null,
      };
    }
    if (id || rt.singleton) {
      let value = await this.client.maybe(rt.item);
      if (value) value = importShape(r, value);
      if (
        value &&
        r.kind === "integration" &&
        r.data.driver_id &&
        value.driver_id !== r.data.driver_id
      )
        throw new Error(
          `${key}: existing integration belongs to a different driver`,
        );
      if (
        value &&
        r.kind === "entity" &&
        r.parent &&
        value.integration_id !== r.parent
      )
        throw new Error(
          `${key}: existing entity belongs to a different integration`,
        );

      if (!value && r.kind === "irCode") await this.client.get(rt.collection);
      if (
        !value &&
        (r.kind === "activityButton" || r.kind === "remoteButton")
      ) {
        await this.client.get(rt.collection);
        value = {};
      }
      if (
        !value &&
        rt.singleton &&
        r.kind !== "activityButton" &&
        r.kind !== "remoteButton"
      )
        throw new Error(`${key}: required endpoint unavailable: ${rt.item}`);
      return { resource: r, id: id ?? String(r.parent ?? r.kind), value };
    }
    // Collection read is also the non-mutating capability check before creating.
    const list = await this.client.list(
      r.kind === "dock"
        ? "/docks"
        : r.kind === "remote"
          ? `${rt.collection}?kind=${r.create?.kind ?? "IR"}`
          : rt.collection,
    );
    const name = r.data.name ?? r.create?.name;
    if (name && list.some((x) => hash(x.name) === hash(name)))
      throw new Error(
        `${key}: matching name already exists; import or set its explicit id`,
      );
    return { resource: r, value: null };
  }
  validate(r: Resource, create: boolean): void {
    const rt = route(r, r.id);
    if (r.kind === "integration") {
      if (create) validateRequest("/intg/setup", "POST", r.create);
      return;
    }
    if (r.kind === "dock" && create) {
      validateRequest("/docks/setup", "POST", r.create);
      return;
    }
    if (["asset", "driverArchive", "pairing"].includes(r.kind)) return;
    if (r.kind === "entity" && create) {
      validateRequest(
        "/intg/instances/{intgId}/entities/{entityId}",
        "POST",
        r.data,
      );
      return;
    }
    if (create && !rt.singleton) {
      validateRequest(
        r.kind === "irCode" ? rt.itemTemplate : rt.collectionTemplate,
        "POST",
        r.create ?? r.data,
      );
    }
    if (Object.keys(r.data).length)
      validateRequest(rt.itemTemplate, "PATCH", r.data);
  }
  async validateCommands(r: Resource): Promise<void> {
    if (
      ![
        "activity",
        "macro",
        "activityButton",
        "activityPage",
        "remoteButton",
        "remotePage",
      ].includes(r.kind)
    )
      return;
    let entities: ObjectValue[] = [];
    let entityIds: string[] = [];
    let live: unknown;
    const own = r.kind === "activity" || r.kind === "macro";
    if (own) {
      const options = r.data.options;
      if (isObject(options) && Array.isArray(options.entity_ids))
        entityIds = options.entity_ids.map(String);
      if (r.id) {
        const a = await this.client.get(
          `/${r.kind === "activity" ? "activities" : "macros"}/${enc(r.id)}`,
        );
        live = a.options;
        if (isObject(a.options) && Array.isArray(a.options.included_entities))
          entities = a.options.included_entities.filter(isObject);
      }
    } else if (r.kind.startsWith("activity")) {
      const a = await this.client.get(`/activities/${enc(r.parent)}`);
      entities =
        isObject(a.options) && Array.isArray(a.options.included_entities)
          ? a.options.included_entities.filter(isObject)
          : Array.isArray(a.entities)
            ? a.entities.filter(isObject)
            : [];
      if (isObject(a.options) && Array.isArray(a.options.entity_ids))
        entityIds = a.options.entity_ids.map(String);
      else entityIds = entities.map((e) => String(e.entity_id));
    }
    const commands: ObjectValue[] = [];
    function collect(v: unknown) {
      if (Array.isArray(v)) v.forEach(collect);
      else if (isObject(v)) {
        if (typeof v.cmd_id === "string") commands.push(v);
        else Object.values(v).forEach(collect);
      }
    }
    collect(r.data);
    // Commands already live on this activity/macro, byte-for-byte, were accepted
    // by the remote. Some drivers accept parameter values outside their advertised
    // source_list, so re-validating an unchanged step would block unrelated edits.
    const liveCommands = new Set<string>();
    (function walk(v: unknown) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (isObject(v)) {
        if (typeof v.cmd_id === "string") liveCommands.add(commandKey(v));
        else
          for (const [k, x] of Object.entries(v))
            if (k !== "included_entities") walk(x);
      }
    })(live);
    if (r.kind.endsWith("Button")) {
      const layouts = await this.client.get<unknown>(
        "/cfg/device/button_layout",
      );
      const names = new Set<string>();
      function scan(x: unknown) {
        if (Array.isArray(x)) x.forEach(scan);
        else if (isObject(x)) {
          if (typeof x.button === "string") names.add(x.button);
          Object.values(x).forEach(scan);
        }
      }
      scan(layouts);
      if (!names.has((r.id ?? "").split("/")[0]!))
        throw new Error(`Unsupported physical button ${r.id}`);
    }
    for (const c of commands) {
      if (r.kind.startsWith("remote")) {
        if (c.entity_id !== undefined)
          throw new Error("Remote-local bindings must not contain entity_id");
      } else if (
        typeof c.entity_id !== "string" ||
        !entityIds.includes(c.entity_id)
      )
        throw new Error(
          `Command ${c.cmd_id}: entity must be included in activity/macro`,
        );
      const id = String(c.entity_id ?? r.parent);
      let e = entities.find((x) => x.entity_id === id);
      // An entity newly added to this activity/macro is not in its live
      // included_entities yet, and /entities/{id} omits entity_commands. Use the
      // remote's own command metadata from another activity/macro that includes it.
      if (!e) e = await this.includedEntity(id);
      if (!e) e = await this.client.get<ObjectValue>(`/entities/${enc(id)}`);
      if (!e) throw new Error(`Missing entity ${id}`);
      if (e.available === false) throw new Error(`Entity ${id} is unavailable`);
      const all: unknown[] = [
        ...(Array.isArray(e.simple_commands) ? e.simple_commands : []),
        ...(Array.isArray(e.entity_commands) ? e.entity_commands : []),
      ];
      if (isObject(e.options) && Array.isArray(e.options.simple_commands))
        all.push(...e.options.simple_commands);
      // No fabricated feature-to-command mapping: exact identifiers must be available.
      if (!all.length) {
        const remote = await this.client.maybe(`/remotes/${enc(id)}`);
        if (remote) {
          if (Array.isArray(remote.simple_commands))
            all.push(...remote.simple_commands);
          if (
            isObject(remote.options) &&
            Array.isArray(remote.options.simple_commands)
          )
            all.push(...remote.options.simple_commands);
        }
      }
      const ids = all.map((x) =>
        typeof x === "string"
          ? x
          : isObject(x)
            ? String(x.cmd_id ?? x.id ?? "")
            : "",
      );
      if (!ids.includes(String(c.cmd_id)))
        throw new Error(
          `Cannot verify command ${c.cmd_id} on ${id}; refresh inventory/command metadata`,
        );
      if (
        Array.isArray(e.entity_commands) &&
        e.entity_commands.includes(c.cmd_id!) &&
        !liveCommands.has(commandKey(c))
      ) {
        const catalog = await this.client.get<unknown>("/cfg/entity/commands");
        const metadata = Array.isArray(catalog)
          ? catalog.filter(isObject).find((x) => x.id === c.cmd_id)
          : undefined;
        if (!metadata) throw new Error(`No parameter metadata for ${c.cmd_id}`);
        validateCommandParameters(
          c,
          metadata,
          await this.client.get<ObjectValue>(`/entities/${enc(id)}`),
        );
      }
    }
  }
  async assertDeletable(r: Resource, id: string): Promise<void> {
    if (
      ![
        "activity",
        "macro",
        "remote",
        "activityPage",
        "remotePage",
        "profilePage",
        "profileGroup",
        "activityGroup",
        "profile",
        "irCode",
        "activityButton",
        "remoteButton",
      ].includes(r.kind)
    )
      throw new Error(
        `Deletion of ${r.kind} is not supported safely; detach explicitly with state forget`,
      );
    if (r.kind.endsWith("Button")) return;
    const contains = (value: unknown): boolean =>
      typeof value === "string"
        ? value === id
        : Array.isArray(value)
          ? value.some(contains)
          : isObject(value)
            ? Object.values(value).some(contains)
            : false;
    const records: Array<{ path: string; data: ObjectValue }> = [];
    for (const [path, field] of [
      ["/activities", "entity_id"],
      ["/macros", "entity_id"],
      ["/profiles", "profile_id"],
      ["/activity_groups", "group_id"],
    ] as const) {
      for (const item of await this.client.list(path)) {
        const identifier = String(item[field]);
        if (identifier !== id)
          records.push({
            path: `${path}/${identifier}`,
            data: await this.client.get(`${path}/${enc(identifier)}`),
          });
        if (path === "/profiles")
          for (const type of ["pages", "groups"])
            for (const child of await this.client.list(
              `/profiles/${enc(identifier)}/${type}`,
            )) {
              if (child[type === "pages" ? "page_id" : "group_id"] !== id)
                records.push({
                  path: `/profiles/${identifier}/${type}`,
                  data: child,
                });
            }
      }
    }
    for (const entity of await this.client.list("/entities"))
      if (entity.entity_type === "remote" && entity.entity_id !== id) {
        const path = `/remotes/${enc(entity.entity_id)}`;
        records.push({ path, data: await this.client.get(path) });
      }
    // Page definitions embedded in their parent are not inbound references.
    const references = records.filter((record) => {
      const data = structuredClone(record.data);
      if (r.kind === "activityPage" || r.kind === "remotePage")
        if (isObject(data.options) && isObject(data.options.user_interface))
          delete data.options.user_interface;
      if (r.kind === "irCode") {
        const hasCommand = (value: unknown): boolean =>
          Array.isArray(value)
            ? value.some(hasCommand)
            : isObject(value)
              ? (value.cmd_id === id &&
                  (value.entity_id === r.parent ||
                    (value.entity_id === undefined &&
                      record.path === `/remotes/${enc(r.parent)}`))) ||
                Object.values(value).some(hasCommand)
              : false;
        return hasCommand(data);
      }
      return contains(data);
    });
    if (references.length)
      throw new Error(
        `Still referenced by ${references.map((x) => x.path).join(", ")}; remove references and apply that plan first`,
      );
    if (r.kind === "profile") {
      for (const child of ["pages", "groups"])
        if ((await this.client.list(`/profiles/${enc(id)}/${child}`)).length)
          throw new Error(
            "Profile still contains pages/groups; remove them first",
          );
    }
  }
  async upload(r: Resource, update = false): Promise<string> {
    const bytes = await verifyArtifact(r);
    const form = new FormData();
    const filename =
      r.kind === "asset"
        ? `uc-${r.sha256}${extname(r.file!)}`
        : basename(r.file!);
    form.set("file", new Blob([new Uint8Array(bytes)]), filename);
    const path =
      r.kind === "asset"
        ? route(r).collection
        : `/intg/install${update ? "?update=true" : ""}`;
    const { data } = await this.client.request<unknown>("POST", path, form);
    const response = Array.isArray(data) ? data[0] : data;
    if (!isObject(response)) throw new Error("Upload returned no identifier");
    const id = r.kind === "asset" ? response.id : (response.driver_id ?? r.id);
    if (typeof id !== "string")
      throw new Error("Upload returned no identifier");
    return id;
  }
}

function commandKey(c: ObjectValue): string {
  const params = isObject(c.params) ? c.params : {};
  return JSON.stringify([
    c.cmd_id,
    c.entity_id ?? null,
    Object.keys(params)
      .sort()
      .map((k) => [k, params[k]]),
  ]);
}

export function validateCommandParameters(
  command: ObjectValue,
  metadata: ObjectValue,
  entity: ObjectValue,
): void {
  const params = isObject(command.params) ? command.params : {};
  const definitions = Array.isArray(metadata.params)
    ? metadata.params.filter(isObject)
    : [];
  for (const key of Object.keys(params))
    if (!definitions.some((p) => p.param === key))
      throw new Error(`Unknown parameter ${key} for ${command.cmd_id}`);
  for (const p of definitions) {
    const key = String(p.param);
    const value = params[key];
    if (value === undefined) {
      if (p.optional !== true)
        throw new Error(`Missing parameter ${key} for ${command.cmd_id}`);
      continue;
    }
    let valid = true;
    if (p.type === "number")
      valid =
        typeof value === "number" &&
        Number.isFinite(value) &&
        (p.min === undefined || value >= Number(p.min)) &&
        (p.max === undefined || value <= Number(p.max));
    else if (p.type === "bool") valid = typeof value === "boolean";
    else if (p.type === "enum")
      valid = Array.isArray(p.values) && p.values.includes(value);
    else if (p.type === "regex") {
      valid = typeof value === "string";
      if (valid && typeof p.regex === "string")
        valid = new RegExp(p.regex).test(value as string);
    } else if (p.type === "selection" && isObject(p.items)) {
      const source = entity[String(p.items.source)];
      const choices = isObject(source)
        ? source[String(p.items.field)]
        : undefined;
      valid = Array.isArray(choices) && choices.includes(value);
    } else throw new Error(`Unsupported parameter metadata for ${key}`);
    if (!valid)
      throw new Error(`Invalid parameter ${key} for ${command.cmd_id}`);
  }
}
