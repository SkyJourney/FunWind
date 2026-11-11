import { afterEach, expect, it, vi } from "vitest";
import type { ViewTransitionInstance } from "react";
import { clearDirection } from "./nav-direction";
import { resetExpandRecord } from "./nav-geometry";
import { createPageMotion, type PageMotion } from "./page-motion";

const controllers: PageMotion[] = [];
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(overrides: Parameters<typeof createPageMotion>[0] = {}) {
  const timers: (() => void)[] = [];
  const motion = createPageMotion({
    supported: () => true,
    reducedMotion: () => false,
    location: () => "/a",
    native: () => undefined,
    schedule: (callback) => {
      timers.push(callback);
      return vi.fn();
    },
    ...overrides,
  });
  controllers.push(motion);
  return { motion, timers };
}
const nav = (from = "/a", to = "/a/901") => ({
  from,
  to,
  anchor: document.createElement("a"),
  point: null,
});
const instance = { name: "page" } as ViewTransitionInstance;
const root = () => document.documentElement;
afterEach(() => {
  controllers.splice(0).forEach((motion) => {
    motion.cancel("disposed");
    motion.engine.dispose();
  });
  clearDirection();
  resetExpandRecord();
  delete root().dataset.motionNav;
  delete root().dataset.motionSkipped;
  vi.restoreAllMocks();
});

it("导航按新注册表开始并定稿，React事件拥有ready与finished；提交URL本身不提前清方向", () => {
  const { motion } = setup();
  const ready = vi.fn();
  const finished = vi.fn();
  motion.engine.register({ level: "page", page: "/a/901" }, { onReady: ready, onFinish: finished });
  motion.start(nav());
  const id = motion.engine.current!.id;
  expect(motion.engine.current).toMatchObject({ phase: "committed", plan: { direction: "push" } });
  expect(root().dataset.motionNav).toBe(String(id));
  expect(root().dataset.motionDirection).toBe("push");
  motion.committed("/a/901");
  expect(root().dataset.motionDirection).toBe("push");
  const cleanup = motion.participate(id, instance, []);
  motion.participate(id, instance, []);
  expect(ready).toHaveBeenCalledOnce();
  cleanup!();
  cleanup!();
  expect(finished).toHaveBeenCalledOnce();
  expect(motion.engine.current).toBeUndefined();
  expect(root().dataset.motionDirection).toBeUndefined();
  expect(root().dataset.motionNav).toBeUndefined();
});
it("全站收敛：非试点路由也建会话，方向由注册表定稿并经新生命周期收尾", () => {
  const { motion } = setup();
  motion.start(nav("/", "/boards"));
  // 移除试点门后，Tab 切换同样建立引擎会话（不再只写属性）
  expect(motion.engine.current?.plan.direction).toBe("tab-next");
  expect(root().dataset.motionDirection).toBe("tab-next");
  motion.committed("/boards");
  // 会话持有方向到参与者收尾，提交本身不提前清属性
  expect(root().dataset.motionDirection).toBe("tab-next");
  motion.participate(motion.engine.current!.id, instance, [])!();
  expect(root().dataset.motionDirection).toBeUndefined();
  motion.start(nav("/boards", "/t/1"));
  expect(motion.engine.current?.plan.direction).toBe("push");
  motion.start(nav("/t/1", "/boards"));
  expect(motion.engine.current?.plan.direction).toBe("pop");
  const id = motion.engine.current!.id;
  motion.participate(id, instance, [])!();
  expect(root().dataset.motionDirection).toBeUndefined();
});
it("快速切换相同方向时，旧React finished不能释放新方向与所有权", () => {
  const { motion } = setup();
  motion.start(nav());
  const old = motion.engine.current!.id;
  const cleanup = motion.participate(old, instance, []);
  motion.start(nav("/a", "/a/902"));
  const next = motion.engine.current!.id;
  cleanup!();
  expect(motion.engine.current?.id).toBe(next);
  expect(root().dataset.motionNav).toBe(String(next));
  expect(root().dataset.motionDirection).toBe("push");
  expect(motion.participate(old, instance, [])).toBeUndefined();
});
it("本次全局hook覆写方向生效；显式Link方向高于注册表默认", () => {
  const { motion } = setup();
  const link = nav();
  link.anchor.setAttribute("data-motion-direction", "pop");
  motion.start(link);
  expect(root().dataset.motionDirection).toBe("pop");
  motion.engine.register({ level: "global" }, { onIntent: () => ({ direction: "fade" }) });
  motion.start(link);
  expect(root().dataset.motionDirection).toBe("fade");
});
it("自动方向不冒充显式hint，全局preset策略可以覆盖默认层级选择", () => {
  const { motion } = setup();
  motion.engine.register({ level: "global" }, { onIntent: () => ({ preset: "admin" }) });
  motion.start(nav());
  expect(motion.engine.current?.plan).toMatchObject({ preset: "admin", direction: "fade" });
  expect(root().dataset.motionDirection).toBe("fade");
});
it("展开与收起保留旧几何和一次性记录，不能在双读判定中消费两次", () => {
  const { motion } = setup();
  const card = document.createElement("div");
  card.setAttribute("data-vt-expand", "");
  const anchor = document.createElement("a");
  card.append(anchor);
  motion.start({ from: "/f/3", to: "/t/1", anchor, point: { x: 100, y: 120 } });
  expect(root().dataset.motionDirection).toBe("expand");
  expect(root().style.getPropertyValue("--vt-x")).toBe("100px");
  motion.start(nav("/t/1", "/f/3"));
  expect(root().dataset.motionDirection).toBe("collapse");
  motion.start(nav("/t/1", "/f/3"));
  expect(root().dataset.motionDirection).toBe("pop");
});
it.each(["cancelled", "disabled"] as const)(
  "%s 时旧/新层都抑制动画，标记保留到React finished",
  (reason) => {
    const { motion } = setup({ config: { enabled: reason !== "disabled" } });
    const skipped = vi.fn();
    motion.engine.register(
      { level: "global" },
      {
        onIntent: () => (reason === "cancelled" ? false : undefined),
        onSkip: skipped,
      },
    );
    motion.start(nav());
    const id = motion.engine.current!.id;
    expect(root().dataset.motionSkipped).toBe(String(id));
    const cleanup = motion.participate(id, instance, []);
    expect(skipped).toHaveBeenCalledWith(expect.anything(), reason);
    expect(root().dataset.motionSkipped).toBe(String(id));
    cleanup!();
    expect(root().dataset.motionSkipped).toBeUndefined();
  },
);
it.each(["no-api", "reduced-motion"] as const)("%s 提前skip，导航提交后没有残留属性", (reason) => {
  const { motion } = setup({
    supported: () => reason !== "no-api",
    reducedMotion: () => reason === "reduced-motion",
  });
  const skipped = vi.fn();
  motion.engine.register({ level: "global" }, { onSkip: skipped });
  motion.start(nav());
  motion.committed("/a/901");
  expect(skipped).toHaveBeenCalledWith(expect.anything(), reason);
  expect(motion.engine.current).toBeUndefined();
  expect(root().dataset.motionNav).toBeUndefined();
  expect(root().dataset.motionDirection).toBeUndefined();
});
it("history/query/redirect不伪造导航动画，失败与超时均清理所有权", () => {
  const { motion, timers } = setup();
  const skipped = vi.fn();
  motion.engine.register({ level: "global" }, { onSkip: skipped });
  motion.pop("/a/901", "/a");
  motion.committed("/a");
  expect(skipped).toHaveBeenCalledWith(expect.anything(), "history");
  motion.start(nav("/t/1?page=1", "/t/1?page=2"));
  expect(motion.engine.current).toBeUndefined();
  motion.start(nav());
  motion.committed("/login");
  expect(skipped).toHaveBeenCalledWith(expect.anything(), "interrupted");
  motion.start(nav());
  timers.at(-1)!();
  expect(skipped).toHaveBeenCalledWith(expect.anything(), "timeout");
  expect(root().dataset.motionNav).toBeUndefined();
});
it("程序化导航经既有guard登记，方向提示只消费一次；绑定清理不能注销新绑定", () => {
  const { motion } = setup();
  const old = motion.bindBegin(() => {});
  const begin = vi.fn((to: string) => motion.start({ from: "/a", to, anchor: null, point: null }));
  const remove = motion.bindBegin(begin);
  old();
  motion.begin("/a/901", "pop");
  expect(begin).toHaveBeenCalledWith("/a/901");
  expect(root().dataset.motionDirection).toBe("pop");
  motion.start(nav());
  expect(root().dataset.motionDirection).toBe("push");
  remove();
  motion.begin("/a/901", "fade");
  expect(root().dataset.motionDirection).toBe("fade");
  expect(begin).toHaveBeenCalledTimes(1);
});
it("native ready失败与晚到finished不影响新会话；React回调不是原生成功证明", async () => {
  const ready = deferred();
  const finished = deferred();
  const { motion } = setup({
    native: () => ({ ready: ready.promise, finished: finished.promise }),
  });
  const events = { onReady: vi.fn(), onSkip: vi.fn() };
  motion.engine.register({ level: "global" }, events);
  motion.start(nav());
  const id = motion.engine.current!.id;
  const cleanup = motion.participate(id, instance, []);
  expect(events.onReady).not.toHaveBeenCalled();
  ready.reject(new Error("快照跳过"));
  await Promise.resolve();
  expect(events.onSkip).toHaveBeenCalledWith(expect.anything(), "transition-error");
  motion.start(nav());
  const next = motion.engine.current!.id;
  finished.reject(new Error("过期失败"));
  cleanup!();
  await Promise.resolve();
  expect(motion.engine.current?.id).toBe(next);
});
it("native句柄可用时等ready，实际finished仍由React cleanup汇合", async () => {
  const ready = deferred();
  const finished = deferred();
  const { motion } = setup({
    native: () => ({ ready: ready.promise, finished: finished.promise }),
  });
  motion.start(nav());
  const id = motion.engine.current!.id;
  const cleanup = motion.participate(id, instance, []);
  ready.resolve();
  await Promise.resolve();
  expect(motion.engine.current?.phase).toBe("ready");
  finished.resolve();
  await Promise.resolve();
  cleanup!();
  expect(motion.engine.current).toBeUndefined();
});
it("hook重入新的意图后，旧prepare不能覆盖最新方向", () => {
  const { motion } = setup();
  let nested = false;
  motion.engine.register(
    { level: "global" },
    {
      onIntent(ctx) {
        if (!nested && ctx.intent.to === "/a/901") {
          nested = true;
          motion.start(nav("/a", "/a/902"));
        }
      },
    },
  );
  motion.start(nav());
  expect(motion.engine.current?.intent.to).toBe("/a/902");
  expect(root().dataset.motionNav).toBe(String(motion.engine.current!.id));
});
