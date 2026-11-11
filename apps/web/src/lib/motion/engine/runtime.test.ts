// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMotionEngine,
  createMotionRegistry,
  type MotionEngine,
  type MotionEngineOptions,
  type MotionIntent,
  type MotionLifecycle,
  type MotionSchedule,
} from "..";

const input: MotionIntent = { from: "/list", to: "/item/1", source: "link" };
const engines: MotionEngine[] = [];
function setup(options: MotionEngineOptions = {}) {
  const timers: { fire: () => void; cancel: ReturnType<typeof vi.fn>; delay: number }[] = [];
  const schedule: MotionSchedule = (fire, delay) => {
    const cancel = vi.fn();
    timers.push({ fire, delay, cancel });
    return cancel;
  };
  const engine = createMotionEngine({ ...options, schedule });
  engines.push(engine);
  return { engine, timers };
}
afterEach(() => {
  engines.splice(0).forEach((engine) => engine.dispose());
  vi.restoreAllMocks();
});

it("无 DOM 的独立实例：生命周期顺序、一次定稿、终态只发一次", () => {
  const order: string[] = [];
  const { engine, timers } = setup({
    hooks: {
      onIntent: () => {
        order.push("intent");
      },
      onBeforeTransition: () => {
        order.push("before");
      },
      onReady: () => {
        order.push("ready");
      },
      onFinish: () => {
        order.push("finish");
      },
    },
  });
  const id = engine.begin(input);
  expect(engine.finish(id)).toBe(false);
  expect(engine.ready(id)).toBe(false);
  expect(engine.commit(id, { preset: "detail", level: 3 })).toMatchObject({ preset: "detail" });
  expect(engine.commit(id, { preset: "form" })).toBeUndefined();
  expect(engine.ready(id)).toBe(true);
  expect(engine.ready(id)).toBe(false);
  expect(engine.finish(id)).toBe(true);
  expect(engine.finish(id)).toBe(false);
  expect(engine.skip(id, "timeout")).toBe(false);
  expect(engine.current).toBeUndefined();
  expect(timers[0]!.cancel).toHaveBeenCalledOnce();
  expect(timers[0]!.delay).toBe(15_000);
  expect(order).toEqual(["intent", "before", "ready", "finish"]);
});
it("未挂 ready 的过渡也能结束；过期 commit/ready/finish 无效", () => {
  const { engine } = setup();
  const old = engine.begin(input);
  engine.commit(old);
  const next = engine.begin(input);
  expect(engine.commit(old)).toBeUndefined();
  expect(engine.ready(old)).toBe(false);
  expect(engine.finish(old)).toBe(false);
  engine.commit(next);
  expect(engine.finish(next)).toBe(true);
});
it("快速连点时旧计时器不能清理新导航，超时只通知一次", () => {
  const skip = vi.fn();
  const { engine, timers } = setup({ hooks: { onSkip: skip } });
  const first = engine.begin(input);
  const second = engine.begin(input);
  expect(skip).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: first }),
    "interrupted",
  );
  timers[0]!.fire();
  expect(engine.current?.id).toBe(second);
  timers[1]!.fire();
  timers[1]!.fire();
  expect(skip).toHaveBeenCalledTimes(2);
  expect(skip).toHaveBeenLastCalledWith(expect.objectContaining({ id: second }), "timeout");
  expect(engine.current).toBeUndefined();
});
it("意图与目标快照隔离外部修改，两个引擎互不共享状态", () => {
  const a = setup().engine;
  const b = setup().engine;
  const origin = { x: 10, y: 20 };
  const target = { page: "reader" };
  a.begin({ ...input, origin }, target);
  origin.x = 99;
  target.page = "other";
  expect(a.current?.intent.origin?.x).toBe(10);
  expect(a.current?.target.page).toBe("reader");
  expect(Object.isFrozen(a.current)).toBe(true);
  expect(b.current).toBeUndefined();
  a.dispose();
  expect(b.begin(input)).toBe(1);
});
it("收尾钩子发起新导航，外层意图不能盖住更新的导航", () => {
  const { engine } = setup();
  let nested = 0;
  engine.register(
    { level: "global" },
    {
      onSkip: (_ctx, reason) => {
        if (reason === "interrupted") nested = engine.begin({ ...input, to: "/newest" });
      },
    },
  );
  engine.begin(input);
  const superseded = engine.begin({ ...input, to: "/middle" });
  expect(engine.current?.id).toBe(nested);
  expect(engine.current?.intent.to).toBe("/newest");
  expect(engine.commit(superseded)).toBeUndefined();
});
it("onIntent 与 onBeforeTransition 的重入也不覆盖新状态", () => {
  const { engine } = setup({
    hooks: {
      onIntent(ctx) {
        if (ctx.intent.to === "/original") engine.begin({ ...input, to: "/new" });
      },
    },
  });
  const old = engine.begin({ ...input, to: "/original" });
  expect(engine.current?.id).not.toBe(old);
  engine.register(
    { level: "global" },
    {
      onBeforeTransition() {
        engine.begin({ ...input, to: "/newer" });
      },
    },
  );
  expect(engine.commit(engine.current!.id)).toBeUndefined();
  expect(engine.current?.intent.to).toBe("/newer");
});
it("finish 通知前释放旧状态；回调可直接开始新会话", () => {
  const { engine } = setup();
  engine.register(
    { level: "global" },
    {
      onFinish() {
        engine.begin(input);
      },
    },
  );
  const old = engine.begin(input);
  engine.commit(old);
  engine.finish(old);
  expect(engine.current?.id).toBe(old + 1);
});
it("dispose 对称清理与幂等，释放后禁止继续使用注册和导航", () => {
  const skip = vi.fn();
  const { engine, timers } = setup({ hooks: { onSkip: skip } });
  const id = engine.begin(input);
  engine.dispose();
  engine.dispose();
  timers[0]!.fire();
  expect(skip).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }), "disposed");
  expect(() => engine.begin(input)).toThrow("已释放");
  expect(() => engine.register({ level: "global" }, {})).toThrow("已释放");
});
it("默认安全调度器能正常清理，不需要浏览器全局", () => {
  const engine = createMotionEngine();
  engine.begin(input);
  engine.dispose();
  expect(engine.current).toBeUndefined();
});

describe("生命周期作用域与错误隔离", () => {
  it("全局→匹配页面→匹配元素，同层按注册序；最近者覆盖且保留未改字段", () => {
    const order: string[] = [];
    const { engine } = setup({
      registry: createMotionRegistry([
        { pattern: /^\/item/, page: { preset: "detail", level: 3 } },
      ]),
    });
    engine.register(
      { level: "element", page: "reader", element: "title" },
      {
        onIntent: () => {
          order.push("element");
          return { preset: "form" };
        },
      },
    );
    engine.register(
      { level: "page", page: "reader" },
      {
        onIntent: (ctx) => {
          order.push("page");
          expect(ctx.plan.direction).toBe("push");
          return { direction: "pop" };
        },
      },
    );
    engine.register(
      { level: "page", page: "other" },
      {
        onIntent: () => {
          order.push("wrong-page");
        },
      },
    );
    engine.register(
      { level: "element", page: "reader", element: "other" },
      {
        onIntent: () => {
          order.push("wrong-element");
        },
      },
    );
    engine.register(
      { level: "global" },
      {
        onIntent: () => {
          order.push("global-1");
          return { direction: "fade" };
        },
      },
    );
    engine.register(
      { level: "global" },
      {
        onIntent: () => {
          order.push("global-2");
          return { direction: "push", preset: undefined };
        },
      },
    );
    const id = engine.begin(input, { page: "reader", element: "title" });
    expect(engine.commit(id)).toMatchObject({ direction: "pop", preset: "form" });
    expect(order).toEqual(["global-1", "global-2", "page", "element"]);
  });
  it("false 终止意图级联，取消只作用于动效，通知钩子仍有对称收尾", () => {
    const later = vi.fn();
    const skipped = vi.fn();
    const { engine } = setup({ hooks: { onIntent: () => false, onSkip: skipped } });
    engine.register({ level: "page", page: "reader" }, { onIntent: later });
    const id = engine.begin(input, { page: "reader" });
    expect(engine.current?.cancelled).toBe(true);
    expect(later).not.toHaveBeenCalled();
    engine.skip(id, "cancelled");
    expect(skipped).toHaveBeenCalledOnce();
  });
  it("注册内容按值保存，卸载/重注册不累积（StrictMode 对称清理契约）", () => {
    const called = vi.fn();
    const scope = { level: "page" as const, page: "reader" };
    const hooks: MotionLifecycle = { onIntent: called };
    const { engine } = setup();
    const remove = engine.register(scope, hooks);
    scope.page = "mutated";
    hooks.onIntent = vi.fn();
    const first = engine.begin(input, { page: "reader" });
    engine.skip(first, "cancelled");
    expect(called).toHaveBeenCalledOnce();
    remove();
    remove();
    const removeAgain = engine.register({ level: "page", page: "reader" }, { onIntent: called });
    engine.begin(input, { page: "reader" });
    expect(called).toHaveBeenCalledTimes(2);
    removeAgain();
  });
  it("元素事件只分派到匹配作用域，不创建导航或计时器", () => {
    const events: string[] = [];
    const { engine, timers } = setup();
    engine.register(
      { level: "element", page: "list", element: "row" },
      {
        onEnter: () => {
          events.push("enter");
        },
        onInView: () => {
          events.push("view");
        },
        onExit: () => {
          events.push("exit");
        },
        onUpdate: () => {
          events.push("update");
        },
      },
    );
    const ctx = { page: "list", element: "row", node: {} as Element };
    for (const event of ["onEnter", "onInView", "onExit", "onUpdate"] as const)
      engine.element(event, ctx);
    expect(events).toEqual(["enter", "view", "exit", "update"]);
    expect(engine.current).toBeUndefined();
    expect(timers).toHaveLength(0);
  });
  it("同步异常、异步拒绝与日志器异常不阻塞后续回调", async () => {
    const reporter = vi.fn(() => {
      throw new Error("日志器失败");
    });
    const next = vi.fn();
    const { engine } = setup({
      reporter,
      hooks: {
        onIntent: () => {
          throw new Error("意图钩子失败");
        },
        onReady: () => Promise.reject(new Error("异步通知失败")),
      },
    });
    engine.register({ level: "global" }, { onIntent: next, onReady: next });
    const id = engine.begin(input);
    engine.commit(id);
    engine.ready(id);
    await Promise.resolve();
    expect(next).toHaveBeenCalledTimes(2);
    expect(reporter).toHaveBeenCalledTimes(2);
    expect(engine.finish(id)).toBe(true);
  });
  it("无自定义日志器时记录警告；意图 hook 的异步结果不当作控制指令", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { engine } = setup({
      hooks: {
        onIntent: (() =>
          Promise.reject(new Error("异步意图"))) as unknown as MotionLifecycle["onIntent"],
      },
    });
    engine.begin(input);
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith("[motion] onIntent", expect.any(Error));
    expect(engine.current?.cancelled).toBe(false);
  });
});
