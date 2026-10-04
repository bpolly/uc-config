import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// curl is a fallback for macOS environments where Node lacks local-network access.
// Credentials go through stdin, never argv. Request bodies live in a private temporary directory.
export const curlFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const dir = await mkdtemp(join(tmpdir(), "uc-config-http-"));
  const quote = (s: string) =>
    `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
  try {
    const lines = [
      "silent",
      "show-error",
      "globoff",
      "max-time = 180",
      `url = ${quote(request.url)}`,
      `request = ${quote(request.method)}`,
      `dump-header = ${quote(join(dir, "headers"))}`,
    ];
    request.headers.forEach((v, k) =>
      lines.push(`header = ${quote(`${k}: ${v}`)}`),
    );
    if (request.body) {
      await writeFile(
        join(dir, "body"),
        Buffer.from(await request.arrayBuffer()),
        { mode: 0o600 },
      );
      lines.push(`data-binary = ${quote("@" + join(dir, "body"))}`);
    }
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("curl", ["--config", "-"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      const abort = () => {
        child.kill();
        reject(new Error("curl request aborted"));
      };
      if (request.signal.aborted) {
        abort();
        return;
      }
      request.signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 200 * 1024 * 1024) {
          child.kill();
          reject(new Error("Response too large"));
        } else chunks.push(chunk);
      });
      // Do not print curl stderr: upstream diagnostics can include private URLs.
      child.stderr.resume();
      child.on("error", () => reject(new Error("curl could not start")));
      child.on("close", (code) => {
        request.signal.removeEventListener("abort", abort);
        code === 0
          ? resolve(Buffer.concat(chunks))
          : reject(new Error(`curl transport failed (${code})`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(lines.join("\n") + "\n");
    });
    const blocks = (await readFile(join(dir, "headers"), "utf8"))
      .trim()
      .split(/\r?\n\r?\n/);
    const last = blocks.at(-1)!;
    const responseLines = last.split(/\r?\n/);
    const status = Number(responseLines.shift()?.split(" ")[1]);
    const headers = new Headers();
    for (const line of responseLines) {
      const colon = line.indexOf(":");
      if (colon > 0)
        headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    return new Response(
      request.method === "HEAD" || [204, 205, 304].includes(status)
        ? null
        : new Uint8Array(bytes),
      { status, headers },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
const curlOrigins = new Set<string>();
export const localFetch: typeof fetch = async (input, init) => {
  const origin = new URL(input instanceof Request ? input.url : String(input))
    .origin;
  if (process.env.UC_HTTP_TRANSPORT === "curl" || curlOrigins.has(origin))
    return curlFetch(input, init);
  try {
    return await fetch(input, init);
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    // Only retry failures known to occur before connection establishment, never a timeout/reset.
    if (
      process.platform === "darwin" &&
      ["EHOSTUNREACH", "ENETUNREACH", "EACCES", "EPERM"].includes(code ?? "")
    ) {
      curlOrigins.add(origin);
      return curlFetch(input, init);
    }
    throw error;
  }
};
