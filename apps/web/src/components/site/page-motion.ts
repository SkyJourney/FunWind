import type { ViewTransitionInstance } from "react";
import {
  createMotionEngine,
  type MotionDirection,
  type MotionEngineOptions,
  type MotionSkipReason,
} from "@/lib/motion";
import { navKeyOf } from "@/lib/motion/nav-guard";
import { clearDirection, releaseDirection, setDirection } from "./nav-direction";
import { resetExpandRecord, resolveNavGeometry, type NavStartInfo } from "./nav-geometry";
import { siteMotionDirection, siteMotionRegistry } from "./motion-routes";

export type MotionNavigationDirection = Exclude<MotionDirection, "expand" | "collapse">;
const DIRECTIONS: readonly MotionNavigationDirection[] = [
  "push",
  "pop",
  "fade",
  "tab-next",
  "tab-prev",
];
interface NativeTransition {
  ready: PromiseLike<void>;
  finished: PromiseLike<void>;
}
interface Options {
  root?: () => HTMLElement;
  location?: () => string;
  supported?: () => boolean;
  reducedMotion?: () => boolean;
  native?: () => NativeTransition | undefined;
  schedule?: MotionEngineOptions["schedule"];
  config?: MotionEngineOptions["config"];
}
interface Owner {
  id: number;
  to: string;
  source: "link" | "programmatic" | "history";
  skip?: "cancelled" | "disabled" | "history";
}
export interface PageNavigation {
  readonly epoch: number;
  readonly from: string;
  readonly to: string;
  readonly obsolete: readonly string[];
}
const pathname = (url: string) => url.split(/[?#]/, 1)[0] ?? "/";

/** Next 宿主桥：生命周期归新内核，方向由注册表定稿后写引擎自有属性 data-motion-direction，
    圆心几何见 nav-geometry，属性时序见 nav-direction（M15 Step 4 退役旧 nav-kind/data-nav）。 */
export function createPageMotion(options: Options = {}) {
  const root = options.root ?? (() => document.documentElement);
  const location =
    options.location ?? (() => `${window.location.pathname}${window.location.search}`);
  const key = (url: string) => navKeyOf(url, `https://motion.invalid${location()}`);
  const supported = options.supported ?? (() => typeof document.startViewTransition === "function");
  const reduced =
    options.reducedMotion ?? (() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const native =
    options.native ??
    (() =>
      (document as Document & { activeViewTransition?: NativeTransition }).activeViewTransition);
  let owner: Owner | undefined;
  let generation = 0;
  let request: PageNavigation | undefined;
  const listeners = new Set<() => void>();
  let beginGuard: ((url: string) => boolean | void) | undefined;
  let completeGuard: ((url?: string) => void) | undefined;
  let nextDirection: MotionNavigationDirection | undefined;
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  function release(id: number) {
    if (owner?.id !== id) return;
    clearDirection(root());
    delete root().dataset.motionNav;
    delete root().dataset.motionSkipped;
    owner = undefined;
  }
  const engine = createMotionEngine({
    registry: siteMotionRegistry,
    schedule: options.schedule,
    config: options.config,
    hooks: {
      onFinish: (ctx) => release(ctx.id),
      onSkip(ctx, reason) {
        if (owner?.id !== ctx.id) return;
        if (reason === "cancelled" || reason === "disabled") {
          clearDirection(root());
          root().dataset.motionSkipped = String(ctx.id);
        } else release(ctx.id);
      },
    },
  });

  function cancel(reason: MotionSkipReason = "interrupted") {
    const epoch = ++generation;
    const owned = owner?.id;
    const current = engine.current;
    if (current) engine.skip(current.id, reason);
    if (generation !== epoch) return;
    if (owned !== undefined) release(owned);
    else clearDirection(root());
    request = undefined;
    emit();
  }

  function prepare(
    nav: NavStartInfo,
    source: Owner["source"],
    direction?: MotionNavigationDirection,
  ) {
    const epoch = ++generation;
    const obsolete = request ? [...request.obsolete, request.to].slice(-32) : [];
    const hint = direction ?? nextDirection ?? nav.anchor?.getAttribute("data-motion-direction");
    const explicit = DIRECTIONS.includes(hint as MotionNavigationDirection)
      ? (hint as MotionNavigationDirection)
      : undefined;
    if (explicit) resetExpandRecord();
    // 几何助手消费一次性记录；显式普通方向不应创建一个未实际展开的收起记录。
    const legacy =
      explicit || source === "history"
        ? { kind: explicit ?? siteMotionDirection(nav.from, nav.to), origin: null }
        : resolveNavGeometry(nav);
    const kind =
      explicit ??
      (legacy.kind === "expand" || legacy.kind === "collapse" ? legacy.kind : undefined);
    const previous = engine.current;
    if (previous) engine.skip(previous.id, "interrupted");
    if (generation !== epoch) return;
    if (owner) release(owner.id);
    const publish = () => {
      if (generation !== epoch) return;
      request = Object.freeze({
        epoch,
        from: key(nav.from),
        to: key(nav.to),
        obsolete: Object.freeze(obsolete),
      });
      emit();
    };
    // 全站收敛（M15 Step 4）：除同 pathname（查询串变化）外，所有路由都建引擎会话，
    // 方向由注册表定稿；共享 layout 组的动画由壳内下沉边界播放，根边界不认领。
    if (pathname(nav.from) === pathname(nav.to)) {
      clearDirection(root());
      publish();
      return;
    }
    const id = engine.begin(
      {
        from: nav.from,
        to: nav.to,
        source,
        ...(kind ? { direction: kind } : {}),
        ...(legacy.origin ? { origin: legacy.origin } : {}),
      },
      { page: pathname(nav.to) },
    );
    if (engine.current?.id !== id || generation !== epoch) return;
    owner = { id, to: pathname(nav.to), source };
    root().dataset.motionNav = String(id);
    if (source === "history") owner.skip = "history";
    else if (!engine.config.enabled) owner.skip = "disabled";
    else if (engine.current.cancelled) owner.skip = "cancelled";
    const available = supported();
    if (!available || reduced()) {
      engine.skip(id, available ? "reduced-motion" : "no-api");
      publish();
      return;
    }
    if (owner.skip) {
      root().dataset.motionSkipped = String(id);
      publish();
      return;
    }
    const plan = engine.commit(id);
    if (plan && owner?.id === id && generation === epoch)
      setDirection(plan.direction, plan.origin, root());
    publish();
  }

  return {
    engine,
    getSnapshot: () => request,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start(nav: NavStartInfo) {
      prepare(nav, nav.anchor ? "link" : "programmatic");
    },
    pop(from: string, to: string) {
      const previous = request;
      const expected = generation + 1;
      prepare({ from, to, anchor: null, point: null }, "history");
      if (generation === expected && previous) completeGuard?.(previous.to);
    },
    bindBegin(callback: (url: string) => boolean | void, complete?: (url?: string) => void) {
      beginGuard = callback;
      completeGuard = complete;
      return () => {
        if (beginGuard === callback) {
          beginGuard = undefined;
          completeGuard = undefined;
        }
      };
    },
    begin(url: string, direction?: MotionNavigationDirection) {
      if (key(url) === key(location())) {
        const previous = request;
        const expected = generation + 1;
        cancel();
        if (!request && previous) completeGuard?.(previous.to);
        return generation === expected;
      }
      nextDirection = direction;
      try {
        if (beginGuard) return beginGuard(url);
        const expected = generation + 1;
        prepare(
          { from: location(), to: url, anchor: null, point: null },
          "programmatic",
          direction,
        );
        return generation === expected;
      } finally {
        nextDirection = undefined;
      }
    },
    committed(url: string, epoch = request?.epoch): boolean {
      const captured = request;
      if (!captured || captured.epoch !== epoch || generation !== epoch) return false;
      const actual = key(url);
      if (
        actual !== captured.to &&
        (actual === captured.from || captured.obsolete.includes(actual))
      )
        return false;
      const owned = owner;
      request = undefined;
      if (owned) {
        if (owned.to !== pathname(url)) engine.skip(owned.id, "interrupted");
        else if (owned.source === "history") engine.skip(owned.id, "history");
      } else releaseDirection(root());
      emit();
      return true;
    },
    participate(id: number, _instance: ViewTransitionInstance, _types: readonly string[]) {
      if (owner?.id !== id || engine.current?.id !== id) return;
      const cleanup = () => {
        engine.finish(id);
        release(id);
      };
      const available = supported();
      if (!available || reduced()) {
        engine.skip(id, available ? "reduced-motion" : "no-api");
        return cleanup;
      }
      if (owner.skip) {
        engine.skip(id, owner.skip);
        return cleanup;
      }
      const handle = native();
      if (handle) {
        void Promise.resolve(handle.ready).then(
          () => {
            engine.ready(id);
          },
          () => {
            engine.skip(id, "transition-error");
          },
        );
        void Promise.resolve(handle.finished).catch(() => {
          engine.skip(id, "transition-error");
        });
      } else {
        // React事件提供逻辑就绪/finished清理，不将它冒充原生ready成功证明。
        engine.ready(id);
      }
      return cleanup;
    },
    cancel,
  };
}
export type PageMotion = ReturnType<typeof createPageMotion>;
