import { CoreClient } from "../src/client.js";
import { Adapter } from "../src/adapter.js";
import type { ObjectValue, State, Target } from "../src/model.js";
import { emptyState } from "../src/model.js";
import { Engine, type Journal } from "../src/engine.js";
import { merge } from "../src/util.js";
export const target: Target = {
  host: "http://remote.test",
  identity: "AA:BB",
  tokenEnv: "UC_API_KEY",
  version: {
    model: "UCR3",
    address: "AA:BB",
    api: "0.18.1",
    core: "0.78.0-non-git",
  },
};
export class FakeRemote {
  data: Record<string, unknown> = {
    "/pub/version": target.version,
    "/activities": [],
    "/macros": [],
    "/entities": [],
    "/profiles": [],
    "/intg/instances": [],
    "/intg/drivers": [],
    "/docks": [],
    "/entities/player": { entity_id: "player" },
    "/cfg/entity/commands": [
      { id: "media_player.on", cmd_id: "on" },
      { id: "media_player.off", cmd_id: "off" },
    ],
    "/cfg/device/button_layout": [
      {
        buttons: [
          { button: "HOME" },
          { button: "MUTE" },
          { button: "VOLUME_UP" },
        ],
      },
    ],
  };
  writes: Array<{ method: string; path: string; body: unknown }> = [];
  fail?: (method: string, path: string) => boolean;
  setupState = "WAIT_USER_ACTION";
  transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (this.fail?.(method, path)) throw new Error("Disconnected");
    const json = (
      value: unknown,
      status = 200,
      headers: Record<string, string> = {},
    ) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    if (method === "GET") {
      if (path.startsWith("/intg/setup/"))
        return json({
          id: path.split("/").at(-1),
          state: this.setupState,
          require_user_action: {
            confirmation: { title: { en: "Press pair" } },
          },
        });
      const source = this.data[path];
      const value =
        path === "/remotes" && Array.isArray(source)
          ? source.filter(
              (item: any) =>
                item.options?.kind === (url.searchParams.get("kind") ?? "IR"),
            )
          : source;
      if (value === undefined) return json({}, 404);
      if (Array.isArray(value)) {
        const page = Number(url.searchParams.get("page") ?? 1),
          limit = Number(url.searchParams.get("limit") ?? 100);
        return json(value.slice((page - 1) * limit, page * limit), 200, {
          "pagination-count": String(value.length),
          "pagination-limit": String(limit),
        });
      }
      return json(value);
    }
    this.writes.push({ method, path, body });
    if (method === "DELETE") {
      delete this.data[path];
      for (const [key, items] of Object.entries(this.data))
        if (Array.isArray(items))
          this.data[key] = items.filter(
            (x: any) =>
              ![x.entity_id, x.page_id, x.profile_id, x.group_id].includes(
                path.split("/").at(-1),
              ),
          );
      return json({});
    }

    if (method === "POST" && path === "/intg/setup")
      return json({ id: body.driver_id, state: this.setupState }, 201);
    if (method === "PATCH") {
      if (this.data[path] === undefined) return json({}, 404);
      const merged = merge(this.data[path] as ObjectValue, body);
      this.data[path] = merged;
      return json(merged);
    }
    if (method === "POST" && Array.isArray(this.data[path])) {
      const field =
        path === "/profiles"
          ? "profile_id"
          : path.endsWith("/ui/pages")
            ? "page_id"
            : "entity_id";
      const id = `generated-${this.writes.length}`;
      const value = { ...body, [field]: id };
      if (path === "/activities" || path === "/macros") {
        value.options = {
          ...value.options,
          included_entities: (body.options?.entity_ids ?? []).map(
            (entity_id: string) => ({
              entity_id,
              entity_commands: ["media_player.on", "media_player.off"],
              simple_commands: ["HOME", "MUTE"],
            }),
          ),
        };
      }
      this.data[`${path}/${id}`] = value;
      (this.data[path] as unknown[]).push(value);
      return json(value, 201);
    }
    return json({}, 200);
  };
  harness() {
    const client = new CoreClient(target.host, "test-token", this.transport);
    const adapter = new Adapter(client);
    let saved: State = emptyState(target.identity);
    let journal: Journal | undefined;
    const engine = new Engine(adapter, {
      save: async (s) => {
        saved = structuredClone(s);
      },
      journal: async (j) => {
        journal = structuredClone(j);
      },
    });
    return {
      client,
      adapter,
      engine,
      state: saved,
      getSaved: () => saved,
      getJournal: () => journal,
    };
  }
}
