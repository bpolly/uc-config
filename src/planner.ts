import type {
  Config,
  ObjectValue,
  Operation,
  Plan,
  Resource,
  State,
  Target,
} from "./model.js";
import { ADAPTER, Adapter, desired } from "./adapter.js";
import { order, validateConfig } from "./compiler.js";
import {
  equal,
  get,
  hash,
  isObject,
  leaves,
  merge,
  project,
  references,
  resolveRefs,
  redact,
} from "./util.js";
export interface PlanOptions {
  overwriteDrift?: boolean;
  adoptDrift?: boolean;
  prune?: boolean;
}
export function configurationView(
  live: ObjectValue,
  shape: ObjectValue,
  baseline?: ObjectValue,
): ObjectValue {
  const view = project(live, shape);
  function secrets(
    target: ObjectValue,
    wanted: ObjectValue,
    prior?: ObjectValue,
  ) {
    for (const [k, v] of Object.entries(wanted))
      if (isObject(v)) {
        if ("$secret" in v) {
          if (prior?.[k]) target[k] = prior[k]!;
          else delete target[k];
        } else {
          const child = isObject(target[k]) ? (target[k] as ObjectValue) : {};
          secrets(
            child,
            v,
            isObject(prior?.[k]) ? (prior[k] as ObjectValue) : undefined,
          );
          if (Object.keys(child).length || isObject(target[k]))
            target[k] = child;
        }
      }
  }
  secrets(view, shape, baseline);
  return view;
}
export async function makePlan(
  config: Config,
  target: Target,
  state: State,
  adapter: Adapter,
  options: PlanOptions = {},
): Promise<Plan> {
  validateConfig(config);
  await adapter.client.verifyTarget(target);
  if (state.identity !== target.identity)
    throw new Error("State belongs to a different remote");
  if (options.overwriteDrift && options.adoptDrift)
    throw new Error("Choose either adopt or overwrite drift");
  const operations: Operation[] = [];
  const deferred: string[] = [];
  const conflicts: string[] = [];
  const changed = new Set<string>();
  // Existing resources can be adopted and referenced in one read-only planning pass.
  const observedState = structuredClone(state);
  for (const key of order(config)) {
    const original = config.resources[key]!;
    const deps = [...references(original), ...(original.dependsOn ?? [])];
    if (deps.some((dep) => !observedState.bindings[dep] || changed.has(dep))) {
      deferred.push(key);
      changed.add(key);
      continue;
    }
    try {
      if (state.setups[key]) {
        deferred.push(key);
        changed.add(key);
        continue;
      }
      const obs = await adapter.observe(original, observedState, key);
      const r = obs.resource;
      const want = desired(r);
      const bound = state.bindings[key];
      if (bound && r.id && bound.id !== r.id)
        throw new Error(
          "Explicit id differs from saved mapping; use a different logical key or explicit state adoption",
        );
      if (
        bound &&
        (bound.resource.kind !== r.kind ||
          !equal(resolveRefs(bound.resource.parent, state), r.parent))
      )
        throw new Error(
          "Resource kind/parent changed; explicit migration required",
        );
      if (
        bound &&
        r.kind === "integration" &&
        r.create &&
        !equal(bound.resource.create, original.create)
      ) {
        const old = resolveRefs(bound.resource, state);
        if (
          old.create?.driver_id !== r.create.driver_id ||
          old.data.device_id !== r.data.device_id
        )
          throw new Error(
            "Integration driver/device identity changed; explicit replacement required",
          );
        if (!equal(old.create?.setup_data, r.create.setup_data)) {
          if (!obs.value) throw new Error("Integration missing");
          operations.push({
            key,
            action: "reconfigure",
            resource: original,
            id: obs.id,
            before: configurationView(
              obs.value,
              merge(bound.baseline, want),
              bound.baseline,
            ),
            desired: want,
          });
          changed.add(key);
          continue;
        }
      }
      if (
        bound &&
        ["dock", "remote", "entity"].includes(r.kind) &&
        r.create &&
        !equal(bound.resource.create, original.create)
      ) {
        const immutable = (x: Resource) =>
          Object.fromEntries(
            Object.entries(x.create ?? {}).filter(
              ([k]) => !["name", "icon", "description"].includes(k),
            ),
          );
        if (!equal(immutable(bound.resource), immutable(original)))
          throw new Error(
            "Immutable provisioning inputs changed; explicit replacement required",
          );
      }
      if (!obs.value && bound)
        throw new Error(
          "Managed resource disappeared; reconcile its state before recreation",
        );
      if (!obs.value) {
        adapter.validate(r, true);
        if (
          ![
            "asset",
            "driverArchive",
            "entity",
            "integration",
            "dock",
            "activity",
            "macro",
          ].includes(r.kind)
        )
          await adapter.validateCommands(r);
        const initial = ["activity", "macro"].includes(r.kind)
          ? (r.create ?? want)
          : want;
        if (!equal(initial, want)) deferred.push(key);
        operations.push({
          key,
          action: "create",
          resource: original,
          ...(obs.id ? { id: obs.id } : {}),
          before: null,
          desired: initial,
        });
        changed.add(key);
        continue;
      }
      adapter.validate(r, false);
      let effective = want;
      const before = configurationView(
        obs.value,
        merge(bound?.baseline ?? {}, want),
        bound?.baseline,
      );
      const conflictsHere: string[] = [];
      if (bound)
        for (const [path, previous] of leaves(bound.baseline)) {
          const intended = get(want, path);
          if (intended === undefined) continue;
          const current = get(before, path);
          if (!equal(current, previous) && !equal(current, intended))
            conflictsHere.push(path.join("."));
        }
      if (conflictsHere.length && !options.overwriteDrift) {
        if (options.adoptDrift) {
          // Adoption requires editing source to current values before the next apply.
          throw new Error(
            `Drift at ${conflictsHere.join(", ")}; import current configuration and update source to adopt it`,
          );
        }
        throw new Error(
          `Drift at ${conflictsHere.join(", ")}; import/adopt live changes or explicitly plan --overwrite-drift`,
        );
      }
      const changedData = !equal(
        configurationView(obs.value, effective, bound?.baseline),
        effective,
      );
      if (changedData)
        await adapter.validateCommands({
          ...r,
          ...(obs.id ? { id: obs.id } : {}),
        });
      if (
        changedData ||
        !bound ||
        !equal(bound.baseline, effective) ||
        !equal(bound.resource, original)
      ) {
        operations.push({
          key,
          action: changedData ? "update" : "adopt",
          resource: original,
          id: obs.id,
          before,
          desired: effective,
        });
        if (changedData) changed.add(key);
        else if (obs.id)
          observedState.bindings[key] = {
            id: obs.id,
            resource: original,
            baseline: effective,
          };
      }
    } catch (e) {
      conflicts.push(`${key}: ${(e as Error).message}`);
      changed.add(key);
    }
  }
  for (const key of Object.keys(state.bindings))
    if (!config.resources[key]) {
      if (!options.prune) {
        conflicts.push(
          `${key}: managed resource removed from source; plan --prune to delete or state forget to relinquish ownership`,
        );
        continue;
      }
      const binding = state.bindings[key]!;
      try {
        await adapter.assertDeletable(
          resolveRefs(binding.resource, state),
          binding.id,
        );
        const obs = await adapter.observe(binding.resource, state, key);
        if (!obs.value)
          throw new Error("Resource already absent; use state forget");
        operations.push({
          key,
          action: "delete",
          resource: binding.resource,
          id: binding.id,
          before: configurationView(
            obs.value,
            binding.baseline,
            binding.baseline,
          ),
          desired: binding.baseline,
        });
      } catch (e) {
        conflicts.push(`${key}: ${(e as Error).message}`);
      }
    }
  const plan: Plan = {
    version: 1,
    adapter: ADAPTER,
    target,
    stateRevision: state.revision,
    configHash: hash(config),
    operations,
    deferred,
    conflicts,
    createdAt: new Date().toISOString(),
    digest: "",
  };
  plan.digest = planDigest(plan);
  return plan;
}
export const planDigest = (plan: Plan): string => hash({ ...plan, digest: "" });
export function checkPlan(plan: Plan): void {
  if (
    plan.version !== 1 ||
    plan.adapter !== ADAPTER ||
    plan.digest !== planDigest(plan)
  )
    throw new Error("Invalid, modified or incompatible plan; regenerate it");
  if (plan.conflicts.length)
    throw new Error(`Plan has conflicts:\n${plan.conflicts.join("\n")}`);
}
export function formatPlan(plan: Plan): string {
  return [
    `Target: ${plan.target.host} (${plan.target.version.model}, core ${plan.target.version.core})`,
    ...plan.operations.flatMap((op) => {
      const header = `${op.action === "create" ? "+" : op.action === "delete" ? "-" : op.action === "adopt" ? "=" : "~"} ${op.action} ${op.key} (${op.resource.kind}${op.id ? `, ${op.id}` : ""})`;
      const display = (value: unknown): string => {
        const text =
          value === undefined ? "(absent)" : JSON.stringify(redact(value));
        return text.length > 180
          ? text.slice(0, 180) + "… (full value in saved plan)"
          : text;
      };
      const changes = leaves(op.desired)
        .filter(([path, v]) => !equal(get(op.before, path), v))
        .map(
          ([path, v]) =>
            `    ${path.join(".")}: ${display(get(op.before, path))} -> ${display(v)}`,
        );
      if (op.action === "reconfigure")
        changes.push(
          `    setup inputs: ${display(op.resource.create?.setup_data)}`,
        );
      return [header, ...changes];
    }),
    ...plan.deferred.map(
      (key) =>
        `… deferred ${key}: apply prerequisites/resume setup, then replan`,
    ),
    ...plan.conflicts.map((c) => `! ${c}`),
    `${plan.operations.length} operations, ${plan.deferred.length} deferred, ${plan.conflicts.length} conflicts`,
  ].join("\n");
}
