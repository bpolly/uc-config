import { Adapter, route } from "./adapter.js";
import { resolveSecrets } from "./client.js";
import type {
  ObjectValue,
  Operation,
  Plan,
  Resource,
  SetupCheckpoint,
  State,
} from "./model.js";
import { configurationView, checkPlan } from "./planner.js";
import { equal, hash, isObject, merge, project, resolveRefs } from "./util.js";
import { validateRequest } from "./schema.js";
export interface Journal {
  planDigest: string;
  status: "running" | "paused" | "failed" | "complete";
  entries: Array<{
    key: string;
    status: "intent" | "created" | "verified" | "awaiting-user";
    id?: string;
    before: ObjectValue | null;
  }>;
}
export class PendingSetup extends Error {}
export interface Store {
  save(state: State): Promise<void>;
  journal(journal: Journal): Promise<void>;
}
export class Engine {
  constructor(
    readonly adapter: Adapter,
    readonly store: Store,
  ) {}
  async apply(
    plan: Plan,
    state: State,
  ): Promise<{ state: State; journal: Journal }> {
    checkPlan(plan);
    await this.adapter.client.verifyTarget(plan.target);
    if (
      state.identity !== plan.target.identity ||
      state.revision !== plan.stateRevision
    )
      throw new Error("State changed since plan; replan");
    // Validate every precondition before issuing any writes. Only proven adoption
    // IDs can be used for dependent preflight reads; newly created IDs are deferred.
    const observedState = structuredClone(state);
    for (const op of plan.operations) {
      await this.precondition(op, observedState);
      if (op.action === "adopt" && op.id)
        observedState.bindings[op.key] = {
          id: op.id,
          resource: op.resource,
          baseline: op.desired,
        };
    }
    const journal: Journal = {
      planDigest: plan.digest,
      status: "running",
      entries: [],
    };
    await this.store.journal(journal);
    try {
      for (const op of plan.operations) {
        await this.precondition(op, state);
        const r = resolveRefs(op.resource, state);
        let id = op.id;
        const entry: Journal["entries"][number] = {
          key: op.key,
          status: "intent",
          ...(id ? { id } : {}),
          before: op.before,
        };
        journal.entries.push(entry);
        await this.store.journal(journal);
        if (op.action === "delete") {
          await this.adapter.assertDeletable(r, id!);
          const rt = route(r, id);
          const path = r.kind.endsWith("Button")
            ? `${rt.item}/${encodeURIComponent((r.id ?? "").split("/")[1]!)}`
            : rt.item;
          await this.adapter.client.request("DELETE", path);
          if (await this.adapter.client.maybe(path))
            throw new Error(`${op.key}: deletion not verified`);
          delete state.bindings[op.key];
          state.revision++;
          await this.store.save(state);
          entry.status = "verified";
          await this.store.journal(journal);
          continue;
        }
        if (
          op.action === "create" ||
          op.action === "reconfigure" ||
          (op.action === "update" &&
            ["asset", "driverArchive"].includes(r.kind))
        ) {
          id =
            op.action === "update"
              ? await this.adapter.upload(r, true)
              : await this.create(op, r, state, journal);
          entry.id = id;
          entry.status = "created";
          await this.store.journal(journal);
          // ID is durable before configuration writes; on failure baseline remains empty.
          state.bindings[op.key] = { id, resource: op.resource, baseline: {} };
          state.revision++;
          await this.store.save(state);
        }
        if (!id) throw new Error(`${op.key}: missing identity`);
        if (
          op.action !== "adopt" &&
          !["asset", "driverArchive"].includes(r.kind)
        )
          await this.update(r, id, op.desired);
        const obs = await this.adapter.observe(
          { ...op.resource, id },
          state,
          op.key,
        );
        const actual =
          obs.value && configurationView(obs.value, op.desired, op.desired);
        if (!equal(actual, op.desired))
          throw new Error(
            `${op.key}: read-back differs from desired configuration`,
          );
        state.bindings[op.key] = {
          id,
          resource: op.resource,
          baseline: op.desired,
        };
        state.revision++;
        await this.store.save(state);
        entry.status = "verified";
        await this.store.journal(journal);
      }
      journal.status = "complete";
      await this.store.journal(journal);
      return { state, journal };
    } catch (e) {
      journal.status = e instanceof PendingSetup ? "paused" : "failed";
      await this.store.journal(journal);
      throw e;
    }
  }
  private async precondition(op: Operation, state: State) {
    const obs = await this.adapter.observe(op.resource, state, op.key);
    const current =
      obs.value &&
      configurationView(
        obs.value,
        merge(state.bindings[op.key]?.baseline ?? {}, op.desired),
        state.bindings[op.key]?.baseline,
      );
    if (!equal(current, op.before))
      throw new Error(`${op.key}: remote changed since plan; replan`);
  }
  private async create(
    op: Operation,
    r: Resource,
    state: State,
    journal: Journal,
  ): Promise<string> {
    this.adapter.validate(r, true);
    if (r.kind === "asset" || r.kind === "driverArchive")
      return this.adapter.upload(r);
    if (r.kind === "integration" || r.kind === "dock") {
      const path = r.kind === "integration" ? "/intg/setup" : "/docks/setup";
      const before = await this.adapter.client.list(
        r.kind === "integration" ? "/intg/instances" : "/docks",
      );
      const ids = before.map((x) =>
        String(x[r.kind === "integration" ? "integration_id" : "dock_id"]),
      );
      if (r.kind === "integration") {
        state.setups[op.key] = {
          key: op.key,
          kind: "integration",
          id: String(r.create?.driver_id),
          resource: op.resource,
          beforeIds: ids,
          ...(op.action === "reconfigure" ? { existingId: op.id } : {}),
          status: "STARTING",
        };
        state.revision++;
        await this.store.save(state);
      }
      const setupBody = await resolveSecrets(
        op.action === "reconfigure"
          ? { ...r.create, reconfigure: true }
          : r.create,
      );
      validateRequest(path, "POST", setupBody);
      const { data } = await this.adapter.client.request(
        "POST",
        path,
        setupBody,
      );
      if (typeof data.id !== "string") throw new Error("Setup returned no id");
      const setup: SetupCheckpoint = {
        key: op.key,
        kind: r.kind,
        id: data.id,
        resource: op.resource,
        beforeIds: ids,
        ...(op.action === "reconfigure" ? { existingId: op.id } : {}),
        status: String(data.state),
      };
      state.setups[op.key] = setup;
      state.revision++;
      await this.store.save(state);
      journal.entries.at(-1)!.id = data.id;
      journal.entries.at(-1)!.status = "awaiting-user";
      await this.store.journal(journal);
      return this.finishSetup(setup, state);
    }
    if (r.kind === "entity") {
      const path = `/intg/instances/${encodeURIComponent(String(r.parent))}/entities/${encodeURIComponent(String(r.create?.entity_id))}`;
      const { data } = await this.adapter.client.request(
        "POST",
        path,
        await resolveSecrets(r.data),
      );
      if (typeof data.entity_id !== "string")
        throw new Error("Entity provisioning returned no entity_id");
      return data.entity_id;
    }
    const rt = route(r, op.id);
    const path = r.kind === "irCode" ? rt.item : rt.collection;
    const createBody = await resolveSecrets(r.create ?? r.data);
    validateRequest(
      r.kind === "irCode" ? rt.itemTemplate : rt.collectionTemplate,
      "POST",
      createBody,
    );
    const { data } = await this.adapter.client.request(
      "POST",
      path,
      createBody,
    );
    const id = data[rt.idField] ?? op.id ?? r.id;
    if (typeof id !== "string")
      throw new Error(`${op.key}: create returned no ${rt.idField}`);
    return id;
  }
  private async update(
    r: Resource,
    id: string,
    data: ObjectValue,
  ): Promise<void> {
    const rt = route(r, id);
    if (r.kind === "pairing") {
      const live = await this.adapter.client.get(rt.item);
      if (live.paired === true) {
        if (!equal(project(live, data), data))
          throw new Error(
            "Bluetooth peer differs; explicit unpairing/replacement required",
          );
        return;
      }
      if (live.pairing_enabled !== true)
        await this.adapter.client.request("PUT", `${rt.item}?enabled=true`);
      throw new PendingSetup(
        `Bluetooth pairing enabled for ${String(r.parent)}. Pair on the device; use pairing respond for any passkey, then replan.`,
      );
    }
    if (!Object.keys(data).length) return;
    let body = data;
    const current = await this.adapter.client.get(rt.item);
    body = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [
        k,
        isObject(v) && !("$secret" in v) && isObject(current[k])
          ? merge(current[k] as ObjectValue, v)
          : v,
      ]),
    );
    if (["activity", "macro"].includes(r.kind) && isObject(body.options)) {
      for (const k of [
        "included_entities",
        "editable",
        "activity_group",
        "button_mapping",
        "user_interface",
      ])
        delete body.options[k];
    }
    if (r.kind === "integration") {
      body = Object.fromEntries(
        Object.entries(body).filter(
          ([k]) => !["driver_id", "device_id"].includes(k),
        ),
      );
    }
    if (r.kind === "driver") {
      body = Object.fromEntries(
        Object.entries(body).filter(([k]) => k !== "driver_id"),
      );
    }
    if (Object.keys(body).length) {
      validateRequest(rt.itemTemplate, "PATCH", body);
      const resolvedBody = await resolveSecrets(body);
      validateRequest(rt.itemTemplate, "PATCH", resolvedBody);
      await this.adapter.client.request("PATCH", rt.item, resolvedBody);
    }
  }
  async finishSetup(setup: SetupCheckpoint, state: State): Promise<string> {
    const r = resolveRefs(setup.resource, state);
    const base = setup.kind === "integration" ? "/intg/setup" : "/docks/setup";
    const status = await this.adapter.client.get(
      `${base}/${encodeURIComponent(setup.id)}`,
    );
    setup.status = String(status.state);
    await this.store.save(state);
    if (status.state === "ERROR")
      throw new Error(
        `${setup.key}: setup failed (${String(status.error)}); inspect setup status before restarting`,
      );
    if (status.state !== "OK")
      throw new PendingSetup(
        `${setup.key}: ${status.state}; run setup status/resume${status.state === "WAIT_USER_ACTION" ? " and provide the requested input" : ""}`,
      );
    const list = await this.adapter.client.list(
      setup.kind === "integration" ? "/intg/instances" : "/docks",
    );
    const field = setup.kind === "integration" ? "integration_id" : "dock_id";
    const matches = list.filter(
      (x) =>
        (setup.existingId
          ? x[field] === setup.existingId
          : !setup.beforeIds.includes(String(x[field]))) &&
        (setup.kind === "dock"
          ? x.dock_id === setup.id
          : x.driver_id === r.create?.driver_id &&
            (!r.data.device_id || x.device_id === r.data.device_id)),
    );
    if (matches.length !== 1)
      throw new Error(
        `${setup.key}: setup finished but resulting identity is ambiguous; inspect inventory and adopt explicitly`,
      );
    const id = String(matches[0]![field]);
    state.bindings[setup.key] = {
      id,
      resource: setup.resource,
      baseline: {},
      setupHash: hash(setup.resource.create),
    };
    delete state.setups[setup.key];
    state.revision++;
    await this.store.save(state);
    return id;
  }
  async resume(state: State): Promise<string[]> {
    const messages: string[] = [];
    for (const s of Object.values(state.setups))
      try {
        const id = await this.finishSetup(s, state);
        messages.push(`${s.key}: provisioned ${id}; replan configuration`);
      } catch (e) {
        if (e instanceof PendingSetup) messages.push(e.message);
        else throw e;
      }
    return messages;
  }
}
