import type {
  MotionContext,
  MotionElementContext,
  MotionElementEvent,
  MotionHookName,
  MotionLifecycle,
  MotionReporter,
  MotionScope,
  MotionSelection,
  MotionSkipReason,
  MotionTarget,
} from "./types";

interface Registration {
  readonly scope: MotionScope;
  readonly hooks: MotionLifecycle;
}

const LEVEL_ORDER = { global: 0, page: 1, element: 2 } as const;

export function createMotionLifecycle(
  reporter: MotionReporter = (error, hook) => console.warn(`[motion] ${hook}`, error),
) {
  const registrations = new Set<Registration>();

  const report: MotionReporter = (error, hook) => {
    try {
      reporter(error, hook);
    } catch {
      // 日志通道也可能失败，不能让观测链阻塞导航。
    }
  };
  function invoke<T>(hook: MotionHookName, callback: () => T): T | undefined {
    try {
      const value = callback();
      if (value && typeof (value as unknown as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(value).catch((error: unknown) => report(error, hook));
        return undefined;
      }
      return value;
    } catch (error) {
      report(error, hook);
      return undefined;
    }
  }
  function applicable(target: MotionTarget) {
    return [...registrations]
      .filter(({ scope }) => {
        if (scope.level === "global") return true;
        if (scope.page !== target.page) return false;
        return scope.level === "page" || scope.element === target.element;
      })
      .sort((a, b) => LEVEL_ORDER[a.scope.level] - LEVEL_ORDER[b.scope.level]);
  }

  return {
    register(scope: MotionScope, hooks: MotionLifecycle) {
      const entry: Registration = { scope: { ...scope }, hooks: { ...hooks } };
      registrations.add(entry);
      return () => {
        registrations.delete(entry);
      };
    },
    intent(
      context: MotionContext,
      isCurrent: () => boolean,
    ): { cancelled: boolean; selection: MotionSelection } {
      let selection: MotionSelection = {};
      for (const { hooks } of applicable(context.target)) {
        if (!isCurrent()) break;
        const result = invoke("onIntent", () =>
          hooks.onIntent?.({
            ...context,
            plan: Object.freeze({ ...context.plan, ...selection }),
          }),
        );
        if (result === false) return { cancelled: true, selection };
        if (result) {
          selection = {
            ...selection,
            ...(result.direction !== undefined ? { direction: result.direction } : {}),
            ...(result.preset !== undefined ? { preset: result.preset } : {}),
          };
        }
      }
      return { cancelled: false, selection };
    },
    notify(
      event: "onBeforeTransition" | "onReady" | "onFinish",
      context: MotionContext,
      isCurrent: () => boolean = () => true,
    ) {
      for (const { hooks } of applicable(context.target)) {
        if (!isCurrent()) break;
        invoke(event, () => hooks[event]?.(context));
      }
    },
    skip(context: MotionContext, reason: MotionSkipReason) {
      for (const { hooks } of applicable(context.target)) {
        invoke("onSkip", () => hooks.onSkip?.(context, reason));
      }
    },
    element(event: MotionElementEvent, context: MotionElementContext) {
      const snapshot = Object.freeze({ ...context });
      for (const { hooks } of applicable(snapshot)) invoke(event, () => hooks[event]?.(snapshot));
    },
    clear() {
      registrations.clear();
    },
  };
}
