export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export type Ref = { $ref: string };
export type Secret = { $secret: string; version?: string };
export type Id = string | Ref;
export type Kind =
  | "activity"
  | "macro"
  | "remote"
  | "profile"
  | "profilePage"
  | "profileGroup"
  | "activityGroup"
  | "activityPage"
  | "remotePage"
  | "activityButton"
  | "remoteButton"
  | "settings"
  | "driver"
  | "integration"
  | "entity"
  | "dock"
  | "irCode"
  | "pairing"
  | "asset"
  | "driverArchive";
export interface Resource {
  kind: Kind;
  id?: string;
  parent?: Id;
  data: ObjectValue;
  create?: ObjectValue;
  dependsOn?: string[];
  file?: string;
  sha256?: string;
  resourceType?: string;
}
export interface Config {
  schemaVersion: 1;
  resources: Record<string, Resource>;
}
export interface Version {
  model: string;
  address: string;
  api: string;
  core: string;
  [key: string]: unknown;
}
export interface Target {
  host: string;
  identity: string;
  version: Version;
  tokenEnv: string;
}
export interface Binding {
  id: string;
  resource: Resource;
  baseline: ObjectValue;
  setupHash?: string;
}
export interface SetupCheckpoint {
  key: string;
  kind: "integration" | "dock";
  id: string;
  resource: Resource;
  beforeIds: string[];
  existingId?: string;
  status: string;
}
export interface State {
  version: 1;
  revision: number;
  identity: string;
  bindings: Record<string, Binding>;
  setups: Record<string, SetupCheckpoint>;
}
export interface Observation {
  id?: string;
  value: ObjectValue | null;
  resource: Resource;
}
export interface Operation {
  key: string;
  action: "create" | "update" | "adopt" | "forget" | "delete" | "reconfigure";
  resource: Resource;
  id?: string;
  before: ObjectValue | null;
  desired: ObjectValue;
}
export interface Plan {
  version: 1;
  adapter: string;
  target: Target;
  stateRevision: number;
  configHash: string;
  operations: Operation[];
  deferred: string[];
  conflicts: string[];
  createdAt: string;
  digest: string;
}
export const emptyState = (identity: string): State => ({
  version: 1,
  revision: 0,
  identity,
  bindings: {},
  setups: {},
});
