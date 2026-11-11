// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createMotionEngine, type MotionDriver, type MotionEngine, type MotionIntent } from "..";

const intent: MotionIntent = { from: "/list", to: "/a", source: "link" };
const engines: MotionEngine[] = [];
function setup() {
  const engine = createMotionEngine({ schedule: () => vi.fn() });
  engines.push(engine);
  return engine;
}
const immediate: MotionDriver = {
  start(update) {
    return { ready: Promise.resolve(), finished: update() };
  },
};
const suspended: MotionDriver = {
  start() {
    const never = new Promise<void>(() => {});
    return { ready: never, finished: never };
  },
};
afterEach(() => {
  engines.splice(0).forEach((engine) => engine.dispose());
});

it.each(["begin", "commit"] as const)(
  "%s 解析异常后预约必须释放，下一次 play 不得执行已经失败的业务更新",
  async (stage) => {
    const error = new Error("注册表读取失败");
    let reads = 0;
    const engine = createMotionEngine({
      schedule: () => vi.fn(),
      registry: {
        resolve() {
          reads += 1;
          if (reads === (stage === "begin" ? 1 : 5)) throw error;
          return undefined;
        },
      },
    });
    engines.push(engine);
    const failedUpdate = vi.fn();
    await expect(engine.play(failedUpdate, intent, { driver: immediate })).rejects.toBe(error);
    expect(failedUpdate).not.toHaveBeenCalled();
    expect(engine.current).toBeUndefined();
    const next = vi.fn();
    await engine.play(next, { ...intent, to: "/b" }, { driver: immediate });
    expect(next).toHaveBeenCalledOnce();
    expect(failedUpdate).not.toHaveBeenCalled();
  },
);
it("快速连点：驱动未更新就被打断时，业务更新仍按意图顺序执行而非 B→A", async () => {
  const engine = setup();
  const order: string[] = [];
  const a = engine.play(
    () => {
      order.push("A");
    },
    intent,
    { driver: suspended },
  );
  const b = engine.play(
    () => {
      order.push("B");
    },
    { ...intent, to: "/b" },
    { driver: immediate },
  );
  await Promise.all([a, b]);
  expect(order).toEqual(["A", "B"]);
});
it("意图 hook 重入 play：旧更新占位早于钩子分发，新导航不能先更新再被覆盖", async () => {
  const engine = setup();
  const order: string[] = [];
  let next: Promise<unknown> | undefined;
  engine.register(
    { level: "global" },
    {
      onIntent(context) {
        if (context.intent.to === "/a") {
          next = engine.play(
            () => {
              order.push("B");
            },
            { ...intent, to: "/b" },
            { driver: immediate },
          );
        }
      },
    },
  );
  await engine.play(
    () => {
      order.push("A");
    },
    intent,
    { driver: immediate },
  );
  await next;
  expect(order).toEqual(["A", "B"]);
});
it("终态 hook 重入第三笔 play，未成为 active 的第二笔更新也不能在第三笔之后执行", async () => {
  const engine = setup();
  const order: string[] = [];
  let c: Promise<unknown> | undefined;
  engine.register(
    { level: "global" },
    {
      onSkip(ctx, reason) {
        if (ctx.intent.to === "/a" && reason === "interrupted") {
          c = engine.play(
            () => {
              order.push("C");
            },
            { ...intent, to: "/c" },
            { driver: immediate },
          );
        }
      },
    },
  );
  const a = engine.play(
    () => {
      order.push("A");
    },
    intent,
    { driver: suspended },
  );
  const b = engine.play(
    () => {
      order.push("B");
    },
    { ...intent, to: "/b" },
    { driver: immediate },
  );
  await Promise.all([a, b, c]);
  expect(order).toEqual(["A", "B", "C"]);
});
it("异步更新内部嵌套 play 不会因串行等待整个 Promise 而死锁", async () => {
  const engine = setup();
  const order: string[] = [];
  const a = engine.play(
    async () => {
      order.push("A:start");
      await engine.play(
        () => {
          order.push("B");
        },
        { ...intent, to: "/b" },
        { driver: immediate },
      );
      order.push("A:end");
    },
    intent,
    { driver: immediate },
  );
  await expect(a).resolves.toMatchObject({ status: "skipped", reason: "interrupted" });
  expect(order).toEqual(["A:start", "B", "A:end"]);
});
it("旧业务更新失败仍释放队列，后续更新可执行且旧错误如实抛出", async () => {
  const engine = setup();
  const order: string[] = [];
  const error = new Error("A 失败");
  const a = engine.play(
    () => {
      order.push("A");
      throw error;
    },
    intent,
    { driver: suspended },
  );
  const b = engine.play(
    () => {
      order.push("B");
    },
    { ...intent, to: "/b" },
    { driver: immediate },
  );
  await expect(a).rejects.toBe(error);
  await expect(b).resolves.toMatchObject({ status: "finished" });
  expect(order).toEqual(["A", "B"]);
});
it.each(["onIntent", "onBeforeTransition", "onReady"] as const)(
  "%s 重入终止旧会话后，不再给其页面层分派非终态事件",
  (event) => {
    const engine = setup();
    const order: string[] = [];
    engine.register(
      { level: "global" },
      {
        [event](ctx: { intent: MotionIntent }) {
          if (ctx.intent.to === "/a") engine.begin({ ...intent, to: "/b" });
        },
      },
    );
    engine.register(
      { level: "page", page: "reader" },
      {
        [event]() {
          order.push("stale-event");
        },
        onSkip() {
          order.push("skip");
        },
      },
    );
    const id = engine.begin(intent, { page: "reader" });
    if (event !== "onIntent") engine.commit(id);
    if (event === "onReady") engine.ready(id);
    expect(order).toEqual(["skip"]);
    expect(engine.current?.intent.to).toBe("/b");
  },
);
it("元素事件复制并冻结上下文，原对象被复用不改变匹配的页面和节点", async () => {
  const engine = setup();
  const nodeA = {} as Element;
  const nodeB = {} as Element;
  const received: unknown[] = [];
  const context = { page: "A", element: "row", node: nodeA };
  engine.register(
    { level: "global" },
    {
      onEnter() {
        context.page = "B";
        context.node = nodeB;
      },
    },
  );
  engine.register(
    { level: "element", page: "A", element: "row" },
    {
      async onEnter(ctx) {
        await Promise.resolve();
        received.push({ page: ctx.page, node: ctx.node, frozen: Object.isFrozen(ctx) });
      },
    },
  );
  engine.element("onEnter", context);
  await Promise.resolve();
  expect(received).toEqual([{ page: "A", node: nodeA, frozen: true }]);
});
