// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  createMotionEngine,
  type MotionDriver,
  type MotionEngine,
  type MotionEngineOptions,
  type MotionIntent,
  type MotionPlayOptions,
} from "..";

const input: MotionIntent = { from: "/list", to: "/item/1", source: "link" };
const engines: MotionEngine[] = [];
function setup(options: MotionEngineOptions = {}) {
  const fire: (() => void)[] = [];
  const engine = createMotionEngine({
    ...options,
    schedule(callback) {
      fire.push(callback);
      return vi.fn();
    },
  });
  engines.push(engine);
  return { engine, fire };
}
const immediateDriver: MotionDriver = {
  start(update) {
    return { ready: Promise.resolve(), finished: update() };
  },
};
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  engines.splice(0).forEach((engine) => engine.dispose());
});

it("驱动受显式注入，开始前定稿→就绪→完成，更新至多一次", async () => {
  const events: string[] = [];
  const { engine } = setup({
    hooks: {
      onBeforeTransition: () => {
        events.push("before");
      },
      onReady: () => {
        events.push("ready");
      },
      onFinish: () => {
        events.push("finish");
      },
    },
  });
  const update = vi.fn(() => {
    events.push("update");
  });
  const start = vi.fn<MotionDriver["start"]>((once, plan) => {
    expect(plan.direction).toBe("push");
    const result = once();
    void once();
    return { ready: Promise.resolve(), finished: result };
  });
  const result = await engine.play(update, { ...input, direction: "push" }, { driver: { start } });
  expect(result).toEqual({ id: 1, status: "finished" });
  expect(start).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledOnce();
  expect(events[0]).toBe("before");
  expect(events.at(-1)).toBe("finish");
  expect(events).toContain("ready");
  expect(engine.current).toBeUndefined();
});
it.each([
  ["no-api", {}, {}, input],
  ["reduced-motion", {}, { driver: immediateDriver, reducedMotion: true }, input],
  ["disabled", { config: { enabled: false } }, { driver: immediateDriver }, input],
  ["cancelled", { hooks: { onIntent: () => false as const } }, { driver: immediateDriver }, input],
  ["history", {}, { driver: immediateDriver }, { ...input, source: "history" }],
  [
    "same-page",
    {},
    { driver: immediateDriver },
    { ...input, from: "/list?q=1", to: "/list?q=2#p1" },
  ],
] as const)(
  "%s 降级不阻塞更新，不触发过渡前/完成通知",
  async (reason, setupOptions, playOptions, intent) => {
    const skipped = vi.fn();
    const before = vi.fn();
    const finish = vi.fn();
    const engineOptions: MotionEngineOptions = setupOptions;
    const { engine } = setup({
      ...engineOptions,
      hooks: {
        ...engineOptions.hooks,
        onSkip: skipped,
        onBeforeTransition: before,
        onFinish: finish,
      },
    });
    const update = vi.fn();
    const result = await engine.play(
      update,
      intent as MotionIntent,
      playOptions as MotionPlayOptions,
    );
    expect(update).toHaveBeenCalledOnce();
    expect(result).toEqual({ id: 1, status: "skipped", reason });
    expect(skipped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 1 }), reason);
    expect(before).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  },
);
it("驱动同步失败前未更新时，回退直接更新且报告 skip", async () => {
  const { engine } = setup();
  const update = vi.fn();
  const result = await engine.play(update, input, {
    driver: {
      start() {
        throw new Error("API 不可用");
      },
    },
  });
  expect(result).toMatchObject({ status: "skipped", reason: "transition-error" });
  expect(update).toHaveBeenCalledOnce();
});
it("驱动已调用更新再抛出，不会重放业务操作", async () => {
  const { engine } = setup();
  const update = vi.fn();
  const result = await engine.play(update, input, {
    driver: {
      start(once) {
        void once();
        throw new Error("捕获快照失败");
      },
    },
  });
  expect(result).toMatchObject({ status: "skipped", reason: "transition-error" });
  expect(update).toHaveBeenCalledOnce();
});
it.each(["ready", "finished"] as const)(
  "驱动 %s 拒绝不会阻塞更新或泄漏未处理拒绝",
  async (field) => {
    const { engine } = setup();
    const update = vi.fn();
    const result = await engine.play(update, input, {
      driver: {
        start(once) {
          void once();
          return {
            ready: field === "ready" ? Promise.reject(new Error("ready 失败")) : Promise.resolve(),
            finished:
              field === "finished" ? Promise.reject(new Error("finished 失败")) : Promise.resolve(),
          };
        },
      },
    });
    expect(result).toMatchObject({ status: "skipped", reason: "transition-error" });
    expect(update).toHaveBeenCalledOnce();
  },
);
it("业务更新异常向调用方抛出，而不是当作动画成功吞掉", async () => {
  const onSkip = vi.fn();
  const { engine } = setup({ hooks: { onSkip } });
  const error = new Error("业务更新失败");
  const update = vi.fn(() => {
    throw error;
  });
  await expect(engine.play(update, input, { driver: immediateDriver })).rejects.toBe(error);
  expect(update).toHaveBeenCalledOnce();
  expect(onSkip).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: 1 }),
    "update-error",
  );
});
it("无 API 的业务更新异常也保留，且不会重复通知终态", async () => {
  const onSkip = vi.fn();
  const { engine } = setup({ hooks: { onSkip } });
  const error = new Error("直接更新失败");
  await expect(engine.play(() => Promise.reject(error), input)).rejects.toBe(error);
  expect(onSkip).toHaveBeenCalledTimes(1);
  expect(onSkip).toHaveBeenCalledWith(expect.anything(), "no-api");
});
it("驱动遗漏更新也执行一次更新，不会丢业务操作", async () => {
  const { engine } = setup();
  const update = vi.fn();
  await engine.play(update, input, {
    driver: { start: () => ({ ready: Promise.resolve(), finished: Promise.resolve() }) },
  });
  expect(update).toHaveBeenCalledOnce();
});
it("超时使悬挂驱动退出；晚到 ready/finished 不改变终态或重复更新", async () => {
  const { engine, fire } = setup();
  const ready = deferred();
  const finished = deferred();
  const update = vi.fn();
  const playing = engine.play(update, input, {
    driver: { start: () => ({ ready: ready.promise, finished: finished.promise }) },
  });
  fire[0]!();
  await expect(playing).resolves.toMatchObject({ status: "skipped", reason: "timeout" });
  ready.resolve();
  finished.reject(new Error("过期驱动失败"));
  await Promise.resolve();
  expect(engine.current).toBeUndefined();
  expect(update).toHaveBeenCalledOnce();
});
it("新导航打断旧 play，不等待旧驱动，旧 Promise 收尾不能清掉新任务", async () => {
  const { engine } = setup();
  const ready = deferred();
  const finished = deferred();
  const update = vi.fn();
  const first = engine.play(update, input, {
    driver: { start: () => ({ ready: ready.promise, finished: finished.promise }) },
  });
  const next = engine.begin({ ...input, to: "/other" });
  await expect(first).resolves.toMatchObject({ status: "skipped", reason: "interrupted" });
  ready.resolve();
  finished.resolve();
  await Promise.resolve();
  expect(engine.current?.id).toBe(next);
  expect(update).toHaveBeenCalledOnce();
});
it("引擎释放使在途 play 收尾，不等待悬挂驱动", async () => {
  const { engine } = setup();
  const never = new Promise<void>(() => {});
  const playing = engine.play(vi.fn(), input, {
    driver: { start: () => ({ ready: never, finished: never }) },
  });
  engine.dispose();
  await expect(playing).resolves.toMatchObject({ status: "skipped", reason: "disposed" });
});
it.each(["onIntent", "onBeforeTransition"] as const)(
  "%s 重入导航时仍恰好执行一次原更新",
  async (hook) => {
    const { engine } = setup({
      hooks: {
        [hook](ctx: { intent: MotionIntent }) {
          if (ctx.intent.to === input.to) engine.begin({ ...input, to: "/newest" });
        },
      },
    });
    const update = vi.fn();
    const start = vi.fn(immediateDriver.start);
    await expect(engine.play(update, input, { driver: { start } })).resolves.toMatchObject({
      status: "skipped",
      reason: "interrupted",
    });
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    expect(engine.current?.intent.to).toBe("/newest");
  },
);
it("play 支持目标声明和作用域，完成后移除临时观察者", async () => {
  const hooks = { onIntent: vi.fn(), onFinish: vi.fn() };
  const { engine } = setup();
  engine.register({ level: "page", page: "reader" }, hooks);
  const driver: MotionDriver = {
    start(once, plan) {
      expect(plan.preset).toBe("detail");
      return immediateDriver.start(once, plan);
    },
  };
  await engine.play(vi.fn(), input, {
    driver,
    page: { preset: "detail" },
    target: { page: "reader" },
  });
  expect(hooks.onFinish).toHaveBeenCalledOnce();
  await engine.play(vi.fn(), input);
  expect(hooks.onFinish).toHaveBeenCalledOnce();
});
