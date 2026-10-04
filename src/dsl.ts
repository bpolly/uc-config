import type {
  Config,
  Id,
  Json,
  ObjectValue,
  Ref,
  Resource,
  Secret,
} from "./model.js";
import type { components } from "./wire.js";
export type Schemas = components["schemas"];
export const ref = (key: string): Ref => ({ $ref: key });
export const secret = (
  source: `env:${string}` | `keychain:${string}`,
  version?: string,
): Secret => ({ $secret: source, ...(version ? { version } : {}) });
export const defineRemote = (config: Config): Config => config;
export const resource = (
  kind: Resource["kind"],
  options: Omit<Resource, "kind">,
): Resource => ({ kind, ...options });
export const command = (
  entity: Id,
  cmdId: string,
  params?: ObjectValue,
): ObjectValue => ({
  entity_id: entity,
  cmd_id: cmdId,
  ...(params ? { params } : {}),
});
export const localCommand = (
  cmdId: string,
  params?: ObjectValue,
): ObjectValue => ({ cmd_id: cmdId, ...(params ? { params } : {}) });
export const delay = (ms: number): ObjectValue => ({
  type: "delay",
  delay: ms,
});
const sequence = (steps: ObjectValue[]): Json[] =>
  steps.map((s) => (s.type === "delay" ? s : { type: "command", command: s }));
export interface ActivityOptions {
  id?: string;
  name: string;
  icon?: string;
  entities: Id[];
  on?: ObjectValue[];
  off?: ObjectValue[];
  options?: ObjectValue;
}
export function activity(o: ActivityOptions): Resource {
  const sequences = {
    ...(o.on ? { on: sequence(o.on) } : {}),
    ...(o.off ? { off: sequence(o.off) } : {}),
  };
  const base = { name: { en: o.name }, ...(o.icon ? { icon: o.icon } : {}) };
  return resource("activity", {
    ...(o.id ? { id: o.id } : {}),
    create: { ...base, options: { entity_ids: o.entities } },
    data: {
      ...base,
      options: {
        ...o.options,
        entity_ids: o.entities,
        ...(Object.keys(sequences).length ? { sequences } : {}),
      },
    },
  });
}
export const integration = (o: {
  id?: string;
  driver: Id;
  name: string;
  setup?: ObjectValue;
  deviceId?: string;
}): Resource =>
  resource("integration", {
    ...(o.id ? { id: o.id } : {}),
    data: {
      driver_id: o.driver,
      name: { en: o.name },
      ...(o.deviceId ? { device_id: o.deviceId } : {}),
    },
    create: {
      driver_id: o.driver,
      name: { en: o.name },
      setup_data: o.setup ?? {},
    },
  });
export const entity = (o: {
  id?: string;
  integration: Id;
  entityId: string;
  data?: ObjectValue;
}): Resource =>
  resource("entity", {
    ...(o.id ? { id: o.id } : {}),
    parent: o.integration,
    create: { entity_id: o.entityId },
    data: o.data ?? {},
  });
export const driver = (id: string, data: ObjectValue): Resource =>
  resource("driver", { id, create: { driver_id: id, ...data }, data });
export const dock = (o: {
  id?: string;
  setup: ObjectValue;
  data?: ObjectValue;
}): Resource =>
  resource("dock", {
    ...(o.id ? { id: o.id } : {}),
    create: o.setup,
    data: o.data ?? {},
  });
export const remote = (o: {
  id?: string;
  create: Schemas["RemoteCreate"];
  data?: Schemas["RemoteUpdate"];
}): Resource =>
  resource("remote", {
    ...(o.id ? { id: o.id } : {}),
    create: o.create as ObjectValue,
    data: (o.data ?? { name: o.create.name }) as ObjectValue,
  });
export const profile = (data: Schemas["ProfileRequest"]): Resource =>
  resource("profile", {
    ...(data.profile_id ? { id: data.profile_id } : {}),
    data: data as ObjectValue,
  });
export const settings = (section: string, data: ObjectValue): Resource =>
  resource("settings", { id: section, data });
export const macro = (o: {
  id?: string;
  name: string;
  entities: Id[];
  steps: ObjectValue[];
}): Resource =>
  resource("macro", {
    ...(o.id ? { id: o.id } : {}),
    create: { name: { en: o.name }, options: { entity_ids: o.entities } },
    data: {
      name: { en: o.name },
      options: { entity_ids: o.entities, sequence: sequence(o.steps) },
    },
  });
export const bind = (
  parent: Id,
  button: string,
  cmd: ObjectValue,
  press: "short_press" | "long_press" = "short_press",
  scope: "activity" | "remote" = "activity",
): Resource =>
  resource(scope === "activity" ? "activityButton" : "remoteButton", {
    parent,
    id: `${button}/${press}`,
    data: { [press]: cmd },
  });
export const page = (
  parent: Id,
  data: ObjectValue,
  id?: string,
  scope: "activity" | "remote" = "activity",
): Resource =>
  resource(scope === "activity" ? "activityPage" : "remotePage", {
    parent,
    ...(id ? { id } : {}),
    data,
  });
export const button = (o: {
  label: string;
  at: [number, number];
  size?: [number, number];
  command: ObjectValue;
}): ObjectValue => ({
  type: "text",
  text: o.label,
  location: { x: o.at[0], y: o.at[1] },
  ...(o.size ? { size: { width: o.size[0], height: o.size[1] } } : {}),
  command: o.command,
});
export const pairing = (parent: Id, expectedPeer?: string): Resource =>
  resource("pairing", {
    parent,
    data: expectedPeer
      ? { paired: true, peer: { address: expectedPeer } }
      : { paired: true },
  });
export const irCode = (
  parent: Id,
  id: string,
  code: { format: string; value: string },
): Resource => resource("irCode", { parent, id, data: code });
export const asset = (type: string, file: string): Resource =>
  resource("asset", { resourceType: type, file, data: {} });
export const driverArchive = (id: string, file: string): Resource =>
  resource("driverArchive", { id, file, data: {} });
