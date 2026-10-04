import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { tsImport } from "tsx/esm/api";
import type { Config, ObjectValue, Resource } from "./model.js";
import { assertJson, isObject, references, secretFields } from "./util.js";
const kinds = new Set([
  "activity",
  "macro",
  "remote",
  "profile",
  "profilePage",
  "profileGroup",
  "activityGroup",
  "activityPage",
  "remotePage",
  "activityButton",
  "remoteButton",
  "settings",
  "driver",
  "integration",
  "entity",
  "dock",
  "irCode",
  "pairing",
  "asset",
  "driverArchive",
]);
export function order(config: Config): string[] {
  const result: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(key: string) {
    if (done.has(key)) return;
    if (visiting.has(key)) throw new Error(`Dependency cycle at ${key}`);
    const r = config.resources[key];
    if (!r) throw new Error(`Unknown resource reference ${key}`);
    visiting.add(key);
    for (const dep of [...references(r), ...(r.dependsOn ?? [])]) visit(dep);
    visiting.delete(key);
    done.add(key);
    result.push(key);
  }
  for (const key of Object.keys(config.resources).sort()) visit(key);
  return result;
}
export function validateConfig(config: Config): void {
  assertJson(config);
  if (config.schemaVersion !== 1 || !isObject(config.resources))
    throw new Error("Expected schemaVersion: 1 and resources map");
  for (const [key, r] of Object.entries(config.resources)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key))
      throw new Error(`Invalid resource key ${key}`);
    if (!kinds.has(r.kind) || !isObject(r.data))
      throw new Error(`${key}: unknown kind or missing data`);
    const secrets = secretFields(r);
    if (secrets.length)
      throw new Error(
        `${key}: use secret() references for ${secrets.join(", ")}`,
      );
    if (r.id && r.id.includes(".."))
      throw new Error(`${key}: invalid identifier`);
    if (
      [
        "profilePage",
        "profileGroup",
        "activityPage",
        "remotePage",
        "activityButton",
        "remoteButton",
        "entity",
        "irCode",
        "pairing",
      ].includes(r.kind) &&
      !r.parent
    )
      throw new Error(`${key}: parent reference or ID required`);
    if (
      r.kind.endsWith("Button") &&
      !/^[A-Z0-9_]+\/(short_press|long_press)$/.test(r.id ?? "")
    )
      throw new Error(
        `${key}: button id must be BUTTON/short_press or BUTTON/long_press`,
      );
    if (r.kind.endsWith("Page")) validatePage(key, r.data);
    if (
      r.kind === "settings" &&
      (!r.id ||
        ![
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
        ].includes(r.id))
    )
      throw new Error(`${key}: unsupported settings section`);
    if (r.kind === "integration" && !r.create && !r.id)
      throw new Error(`${key}: integration needs setup data or existing id`);
    if ((r.kind === "asset" || r.kind === "driverArchive") && !r.file)
      throw new Error(`${key}: file required`);
  }
  order(config);
}
function validatePage(key: string, data: ObjectValue) {
  if (!Array.isArray(data.items) || !isObject(data.grid)) return;
  const grid = data.grid;
  const occupied = new Set<string>();
  for (const item of data.items) {
    if (!isObject(item) || !isObject(item.location)) continue;
    const x = Number(item.location.x),
      y = Number(item.location.y);
    const size = isObject(item.size) ? item.size : {};
    const w = Number(size.width ?? 1),
      h = Number(size.height ?? 1);
    if (
      ![x, y, w, h, grid.width, grid.height].every(
        (n) => typeof n === "number" && Number.isSafeInteger(n),
      ) ||
      x < 0 ||
      y < 0 ||
      w < 1 ||
      h < 1 ||
      x + w > Number(grid.width) ||
      y + h > Number(grid.height)
    )
      throw new Error(`${key}: widget outside grid`);
    if (w * h > 10000) throw new Error(`${key}: excessive grid size`);
    for (let i = x; i < x + w; i++)
      for (let j = y; j < y + h; j++) {
        const cell = `${i},${j}`;
        if (occupied.has(cell)) throw new Error(`${key}: overlapping widgets`);
        occupied.add(cell);
      }
  }
}
export async function compile(file: string): Promise<Config> {
  const mod = await tsImport(resolve(file), import.meta.url);
  const config = (
    mod.default?.schemaVersion ? mod.default : mod.default?.default
  ) as Config;
  validateConfig(config);
  for (const r of Object.values(config.resources))
    if (r.file) {
      r.file = resolve(file, "..", r.file);
      r.sha256 = createHash("sha256")
        .update(await readFile(r.file))
        .digest("hex");
    }
  return structuredClone(config);
}
export async function verifyArtifact(resource: Resource): Promise<Buffer> {
  if (!resource.file || !resource.sha256)
    throw new Error("Uncompiled file artifact");
  const bytes = await readFile(resource.file);
  if (createHash("sha256").update(bytes).digest("hex") !== resource.sha256)
    throw new Error("File changed since compilation; recompile and replan");
  return bytes;
}
