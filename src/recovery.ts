import { Adapter, ADAPTER } from "./adapter.js";
import type { Journal } from "./engine.js";
import type { Operation, Plan, State, Target } from "./model.js";
import { configurationView, planDigest } from "./planner.js";
import { equal, get, hash, leaves, merge } from "./util.js";
export async function rollbackPlan(
  journal: Journal,
  target: Target,
  state: State,
  adapter: Adapter,
): Promise<Plan> {
  await adapter.client.verifyTarget(target);
  const operations: Operation[] = [];
  const conflicts: string[] = [];
  for (const entry of [...journal.entries].reverse()) {
    const b = state.bindings[entry.key];
    if (!b) {
      conflicts.push(
        `${entry.key}: missing mapping; deletion/uncertain creation requires explicit recovery`,
      );
      continue;
    }
    if (entry.before === null) {
      conflicts.push(
        `${entry.key}: created resource has no prior image; remove it through a separate prune plan`,
      );
      continue;
    }
    if (
      ["integration", "dock", "driverArchive", "asset", "pairing"].includes(
        b.resource.kind,
      )
    ) {
      conflicts.push(
        `${entry.key}: provisioning/pairing/upload side effects require explicit recovery`,
      );
      continue;
    }
    const obs = await adapter.observe(b.resource, state, entry.key);
    if (!obs.value) {
      conflicts.push(`${entry.key}: no live resource`);
      continue;
    }
    const shape = merge(b.baseline, entry.before);
    const current = configurationView(obs.value, shape, b.baseline);
    if (
      !equal(configurationView(obs.value, b.baseline, b.baseline), b.baseline)
    ) {
      conflicts.push(
        `${entry.key}: changed after apply; reconcile drift before rollback`,
      );
      continue;
    }
    const absent = leaves(b.baseline).filter(
      ([path]) => get(entry.before, path) === undefined,
    );
    if (absent.length) {
      conflicts.push(
        `${entry.key}: fields absent before apply require explicit clearing: ${absent.map(([p]) => p.join(".")).join(", ")}`,
      );
      continue;
    }
    const r = { ...b.resource, data: entry.before };
    adapter.validate(r, false);
    operations.push({
      key: entry.key,
      action: "update",
      id: b.id,
      resource: r,
      before: current,
      desired: entry.before,
    });
  }
  const plan: Plan = {
    version: 1,
    adapter: ADAPTER,
    target,
    stateRevision: state.revision,
    configHash: hash(journal),
    operations,
    deferred: [],
    conflicts,
    createdAt: new Date().toISOString(),
    digest: "",
  };
  plan.digest = planDigest(plan);
  return plan;
}
