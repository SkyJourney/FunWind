import { createMotionConfig, type MotionConfig } from "./config";
import { createMotionLifecycle } from "./lifecycle";
import { playMotion, type MotionPlayOptions, type MotionPlayResult } from "./play";
import { createMotionRegistry, resolveMotionPlan } from "./resolver";
import { createMotionUpdates } from "./updates";
import type {
  MotionContext,
  MotionIntent,
  MotionLifecycle,
  MotionPageDeclaration,
  MotionRegistry,
  MotionReporter,
  MotionSchedule,
  MotionScope,
  MotionSelection,
  MotionSkipReason,
  MotionTarget,
  MotionUpdate,
} from "./types";

export interface MotionSession extends MotionContext {
  readonly phase: "intent" | "committed" | "ready";
  readonly cancelled: boolean;
}

export interface MotionEngineOptions {
  readonly config?: Partial<MotionConfig>;
  readonly registry?: MotionRegistry;
  readonly hooks?: MotionLifecycle;
  readonly reporter?: MotionReporter;
  readonly schedule?: MotionSchedule;
}

const scheduleTimeout: MotionSchedule = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

export function createMotionEngine(options: MotionEngineOptions = {}) {
  const config = createMotionConfig(options.config);
  const registry = options.registry ?? createMotionRegistry();
  const lifecycle = createMotionLifecycle(options.reporter);
  if (options.hooks) lifecycle.register({ level: "global" }, options.hooks);
  const schedule = options.schedule ?? scheduleTimeout;
  const reserveUpdate = createMotionUpdates();
  let sequence = 0;
  let active: MotionSession | undefined;
  let selection: MotionSelection = {};
  let cancelTimer: (() => void) | undefined;
  let flushUpdate: (() => void) | undefined;
  let disposed = false;

  function end(id: number, reason?: MotionSkipReason): boolean {
    if (active?.id !== id) return false;
    const context = active;
    const flush = flushUpdate;
    active = undefined;
    flushUpdate = undefined;
    cancelTimer?.();
    cancelTimer = undefined;
    // 旧业务更新先入队，终态钩子才可发起新意图；否则会出现 B 更新后又被 A 覆盖。
    flush?.();
    if (reason) lifecycle.skip(context, reason);
    else lifecycle.notify("onFinish", context);
    return true;
  }

  function start(
    input: MotionIntent,
    target: MotionTarget = {},
    claim?: (id: number) => void,
    handoff?: () => void,
  ): number {
    if (disposed) throw new Error("动效引擎已释放");
    const previous = active?.id;
    const id = ++sequence;
    claim?.(id);
    if (previous !== undefined) end(previous, "interrupted");
    // 收尾钩子可能重入并发起更新的导航，外层意图不能覆盖它。
    if (sequence !== id || disposed) return id;
    const intent = Object.freeze({
      ...input,
      ...(input.origin ? { origin: Object.freeze({ ...input.origin }) } : {}),
    });
    active = Object.freeze({
      id,
      intent,
      target: Object.freeze({ ...target }),
      plan: resolveMotionPlan(intent, registry, config),
      phase: "intent",
      cancelled: false,
    });
    flushUpdate = handoff;
    const result = lifecycle.intent(active, () => active?.id === id);
    if (active?.id === id) {
      selection = result.selection;
      active = Object.freeze({
        ...active,
        cancelled: result.cancelled,
        plan: resolveMotionPlan(intent, registry, config, undefined, selection),
      });
      cancelTimer = schedule(() => end(id, "timeout"), config.safetyTimeoutMs);
    }
    return id;
  }

  const engine = {
    config,
    get current(): MotionSession | undefined {
      return active;
    },
    register(scope: MotionScope, hooks: MotionLifecycle) {
      if (disposed) throw new Error("动效引擎已释放");
      return lifecycle.register(scope, hooks);
    },
    begin(input: MotionIntent, target: MotionTarget = {}): number {
      return start(input, target);
    },
    commit(id: number, page?: MotionPageDeclaration) {
      if (active?.id !== id || active.phase !== "intent") return undefined;
      active = Object.freeze({
        ...active,
        plan: resolveMotionPlan(active.intent, registry, config, page, selection),
        phase: "committed",
      });
      const plan = active.plan;
      lifecycle.notify("onBeforeTransition", active, () => active?.id === id);
      return active?.id === id ? plan : undefined;
    },
    ready(id: number): boolean {
      if (active?.id !== id || active.phase !== "committed") return false;
      active = Object.freeze({ ...active, phase: "ready" });
      lifecycle.notify("onReady", active, () => active?.id === id);
      return true;
    },
    finish(id: number): boolean {
      if (active?.id !== id || active.phase === "intent") return false;
      return end(id);
    },
    skip(id: number, reason: MotionSkipReason): boolean {
      return end(id, reason);
    },
    element: lifecycle.element,
    play(
      update: MotionUpdate,
      intent: MotionIntent,
      playOptions: MotionPlayOptions = {},
    ): Promise<MotionPlayResult> {
      return playMotion(engine, update, intent, playOptions, reserveUpdate, (claim, handoff) =>
        start(intent, playOptions.target, claim, handoff),
      );
    },
    dispose() {
      disposed = true;
      if (active) end(active.id, "disposed");
      lifecycle.clear();
    },
  };
  return engine;
}

export type MotionEngine = ReturnType<typeof createMotionEngine>;
