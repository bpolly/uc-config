import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
  open,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { Json, ObjectValue, State } from "./model.js";
export function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const hash = (v: unknown): string =>
  createHash("sha256").update(canonical(v)).digest("hex");
export const equal = (a: unknown, b: unknown): boolean =>
  canonical(a) === canonical(b);
export const isObject = (v: unknown): v is ObjectValue =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function assertJson(
  v: unknown,
  path = "config",
  seen = new Set<object>(),
): asserts v is Json {
  if (
    v === null ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v))
  )
    return;
  if (typeof v !== "object" || seen.has(v))
    throw new Error(
      `${path}: expected serializable JSON (no undefined, functions, cycles or non-finite numbers)`,
    );
  if (
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) !== Object.prototype &&
    Object.getPrototypeOf(v) !== null
  )
    throw new Error(`${path}: expected plain object`);
  seen.add(v);
  for (const [k, x] of Object.entries(v)) {
    if (["__proto__", "constructor", "prototype"].includes(k))
      throw new Error(`${path}: forbidden key ${k}`);
    assertJson(x, `${path}.${k}`, seen);
  }
  seen.delete(v);
}
export function project(live: ObjectValue, shape: ObjectValue): ObjectValue {
  const value = (actual: Json, wanted: Json): Json => {
    if (isObject(wanted) && !("$secret" in wanted) && isObject(actual))
      return project(actual, wanted);
    if (Array.isArray(wanted) && Array.isArray(actual))
      return actual.map((item, i) =>
        wanted[i] === undefined ? item : value(item, wanted[i]!),
      );
    return actual;
  };
  return Object.fromEntries(
    Object.entries(shape)
      .filter(([k]) => k in live)
      .map(([k, v]) => [k, value(live[k]!, v)]),
  );
}
export function merge(a: ObjectValue, b: ObjectValue): ObjectValue {
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b))
    out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : v;
  return out;
}
export function leaves(
  v: ObjectValue,
  path: string[] = [],
): Array<[string[], Json]> {
  return Object.entries(v).flatMap(([k, x]) =>
    isObject(x) && Object.keys(x).length && !("$secret" in x)
      ? leaves(x, [...path, k])
      : [[[...path, k], x] as [string[], Json]],
  );
}
export const get = (v: unknown, path: string[]): unknown =>
  path.reduce<unknown>((a, k) => (isObject(a) ? a[k] : undefined), v);
export function set(v: ObjectValue, path: string[], value: Json): void {
  const [key, ...rest] = path;
  if (!key) throw new Error("Empty path");
  if (!rest.length) v[key] = value;
  else {
    if (!isObject(v[key])) v[key] = {};
    set(v[key] as ObjectValue, rest, value);
  }
}
export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
export async function saveJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}
export async function withLock<T>(
  file: string,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "wx", 0o600).catch(() => {
    throw new Error(
      `Target locked: ${file}. If its process has exited, inspect the journal before removing this lock.`,
    );
  });
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    return await fn();
  } finally {
    await handle.close();
    await unlink(file);
  }
}
export function resolveRefs<T>(value: T, state: State): T {
  if (Array.isArray(value)) return value.map((x) => resolveRefs(x, state)) as T;
  if (isObject(value)) {
    if (typeof value.$ref === "string") {
      const b = state.bindings[value.$ref];
      if (!b) throw new Error(`Unresolved reference: ${value.$ref}`);
      return b.id as T;
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveRefs(v, state)]),
    ) as T;
  }
  return value;
}
export function references(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(references);
  if (isObject(value))
    return typeof value.$ref === "string"
      ? [value.$ref]
      : Object.values(value).flatMap(references);
  return [];
}
const sensitive =
  /password|token|secret|api[_-]?key|authorization|cookie|passkey|(^|_)pin$/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      sensitive.test(k) ? "[REDACTED]" : redact(v),
    ]),
  );
}
/** Archive type from its magic bytes; the remote may not send a filename. */
export function archiveExtension(bytes: Uint8Array, filename?: string): string {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return ".zip";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return ".tar.gz";
  if (
    bytes.length > 262 &&
    String.fromCharCode(...bytes.slice(257, 262)) === "ustar"
  )
    return ".tar";
  return /\.(tar\.gz|tgz|tar|zip)$/i.exec(filename ?? "")?.[0] ?? ".bin";
}
export function secretFields(v: unknown, path: string[] = []): string[] {
  if (!isObject(v) && !Array.isArray(v)) return [];
  if (isObject(v) && "$secret" in v) return [];
  return Object.entries(v).flatMap(([k, x]) =>
    sensitive.test(k) && !(isObject(x) && "$secret" in x)
      ? [[...path, k].join(".")]
      : secretFields(x, [...path, k]),
  );
}
