import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ObjectValue, Target, Version } from "./model.js";
import { isObject } from "./util.js";
import { localFetch } from "./transport.js";
export class ApiError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
  ) {
    super(`${method} ${path}: HTTP ${status}`);
  }
}
export class CoreClient {
  readonly base: URL;
  constructor(
    host: string,
    private token?: string,
    private transport: typeof fetch = localFetch,
    private timeout = 15000,
  ) {
    this.base = new URL(host.includes("://") ? host : `http://${host}`);
    if (
      !["http:", "https:"].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      !["/", "/api", "/api/"].includes(this.base.pathname)
    )
      throw new Error(
        "Host must be an HTTP(S) remote origin, optionally ending in /api",
      );
    this.base.pathname = "/api/";
  }
  async request<T = ObjectValue>(
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<{ data: T; headers: Headers }> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes(".."))
      throw new Error("Invalid API path");
    const url = new URL(path.slice(1), this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith("/api/"))
      throw new Error("Invalid API origin");
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart)
      headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.transport(url, {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : multipart
              ? body
              : JSON.stringify(body),
        signal: AbortSignal.timeout(multipart ? 180000 : this.timeout),
        redirect: "error",
      });
    } catch {
      throw new Error(
        `${method} ${path}: transport failed or timed out${method === "GET" ? "" : " (write outcome may be uncertain; inspect journal before retrying)"}`,
      );
    }
    if (!response.ok) throw new ApiError(response.status, method, path);
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${method} ${path}: expected JSON response`);
    }
    return { data: data as T, headers: response.headers };
  }
  async get<T = ObjectValue>(path: string): Promise<T> {
    return (await this.request<T>("GET", path)).data;
  }
  async maybe(path: string): Promise<ObjectValue | null> {
    try {
      return await this.get(path);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
  async list(path: string): Promise<ObjectValue[]> {
    const pathname = path.split("?")[0]!;
    const paginated =
      /^\/(entities|activities|macros|remotes|intg\/drivers|intg\/instances|resources\/[^/]+|intg\/instances\/[^/]+\/entities)$/.test(
        pathname,
      );
    if (!paginated) {
      const data = await this.get<unknown>(path);
      if (!Array.isArray(data) || !data.every(isObject))
        throw new Error(`${path}: expected list response`);
      return data;
    }
    const out: ObjectValue[] = [];
    let last = "";
    for (let page = 1; page <= 10000; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const { data, headers } = await this.request<unknown>(
        "GET",
        `${path}${separator}page=${page}&limit=100`,
      );
      if (!Array.isArray(data))
        throw new Error(`${path}: expected list response`);
      if (!data.every(isObject))
        throw new Error(`${path}: unexpected list item`);
      const fingerprint = JSON.stringify(data);
      if (data.length && fingerprint === last)
        throw new Error(`${path}: server ignored pagination`);
      last = fingerprint;
      out.push(...data);
      const count = headers.get("pagination-count");
      if (count !== null && out.length >= Number(count)) return out;
      if (
        !data.length ||
        (count === null &&
          data.length < Number(headers.get("pagination-limit") ?? 100))
      )
        return out;
    }
    throw new Error(`${path}: pagination limit exceeded`);
  }
  async download(path: string): Promise<Uint8Array> {
    return (await this.downloadFile(path)).bytes;
  }
  /** Bytes plus the server-suggested filename (Content-Disposition), if any. */
  async downloadFile(
    path: string,
  ): Promise<{ bytes: Uint8Array; filename?: string }> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes(".."))
      throw new Error("Invalid API path");
    const response = await this.transport(new URL(path.slice(1), this.base), {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(180000),
      redirect: "error",
    });
    if (!response.ok) throw new ApiError(response.status, "GET", path);
    const disposition = response.headers.get("content-disposition") ?? "";
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      ...(m ? { filename: decodeURIComponent(m[1]!) } : {}),
    };
  }
  async version(): Promise<Version> {
    return this.get<Version>("/pub/version");
  }
  async verifyTarget(target: Target): Promise<void> {
    const v = await this.version();
    if (v.address !== target.identity || v.model !== "UCR3")
      throw new Error("Remote identity/model differs from target");
    if (v.core !== target.version.core || v.api !== target.version.api)
      throw new Error("Remote firmware changed; reconnect and replan");
  }
}
export async function resolveSecrets<T>(v: T): Promise<T> {
  if (Array.isArray(v)) return (await Promise.all(v.map(resolveSecrets))) as T;
  if (isObject(v)) {
    if (typeof v.$secret === "string") {
      const source = v.$secret;
      if (source.startsWith("env:")) {
        const value = process.env[source.slice(4)];
        if (!value)
          throw new Error(
            `Missing secret environment variable ${source.slice(4)}`,
          );
        return value as T;
      }
      if (source.startsWith("keychain:") && process.platform === "darwin") {
        const name = source.slice(9);
        const slash = name.indexOf("/");
        try {
          const { stdout } = await promisify(execFile)("security", [
            "find-generic-password",
            "-s",
            slash < 0 ? "uc-config" : name.slice(0, slash),
            "-a",
            slash < 0 ? name : name.slice(slash + 1),
            "-w",
          ]);
          return stdout.trimEnd() as T;
        } catch {
          throw new Error(`Cannot read Keychain secret ${name}`);
        }
      }
      throw new Error(
        "Secret source must be env:NAME or keychain:service/account",
      );
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(v).map(async ([k, x]) => [k, await resolveSecrets(x)]),
      ),
    ) as T;
  }
  return v;
}
