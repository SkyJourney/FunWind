import { afterEach, expect, it, vi } from "vitest";
import type { ViewTransitionInstance } from "react";
import { clearDirection } from "./nav-direction";
import { resetExpandRecord } from "./nav-geometry";
import { createPageMotion, type PageMotion } from "./page-motion";

const all: PageMotion[] = [];
const make = (options: Parameters<typeof createPageMotion>[0] = {}) => {
  const motion = createPageMotion({
    supported: () => true,
    reducedMotion: () => false,
    native: () => undefined,
    schedule: () => () => {},
    ...options,
  });
  all.push(motion);
  return motion;
};
const nav = (to: string, from = "/a") => ({
  from,
  to,
  anchor: document.createElement("a"),
  point: null,
});
afterEach(() => {
  all.splice(0).forEach((motion) => {
    motion.cancel("disposed");
    motion.engine.dispose();
  });
  clearDirection();
  resetExpandRecord();
  delete document.documentElement.dataset.motionNav;
  delete document.documentElement.dataset.motionSkipped;
});

it("发布请求前必须先建立动效会话，历史URL已恢复时同步提交也不能留下无提交机会的会话", () => {
  const motion = make();
  motion.subscribe(() => {
    const request = motion.getSnapshot();
    if (request) motion.committed(request.to, request.epoch);
  });
  motion.pop("/a/901", "/a");
  expect(motion.engine.current).toBeUndefined();
  expect(document.documentElement.dataset.motionNav).toBeUndefined();
});
it("旧render捕获的提交代次不能取消新请求，顺序路由队列的旧目标提交也不能认领新请求", () => {
  const motion = make();
  motion.start(nav("/a/901"));
  const old = motion.getSnapshot()!;
  motion.start(nav("/a/902"));
  const latest = motion.getSnapshot()!;
  const id = motion.engine.current!.id;
  expect(motion.committed("/login", old.epoch)).toBe(false);
  expect(motion.committed("/a/901", latest.epoch)).toBe(false);
  expect(motion.engine.current?.id).toBe(id);
  expect(motion.committed("/a/902", latest.epoch)).toBe(true);
  expect(motion.getSnapshot()).toBeUndefined();
});
it("原地址和仅hash程序化导航不登记pending；query变化仍交给guard", () => {
  const motion = make({ location: () => "/a/901?motion=1" });
  const begin = vi.fn();
  motion.bindBegin(begin);
  motion.begin("/a/901?motion=1#top");
  motion.begin("/a/901?motion=1&_rsc=x");
  motion.begin("/a/901?motion=1");
  expect(begin).not.toHaveBeenCalled();
  expect(motion.getSnapshot()).toBeUndefined();
  motion.begin("/a/901?motion=2");
  expect(begin).toHaveBeenCalledExactlyOnceWith("/a/901?motion=2");
});
it("hash或history中止较早的pending时只结清其比较键，不泄漏进度状态", () => {
  const motion = make({ location: () => "/a" });
  const complete = vi.fn();
  motion.bindBegin(vi.fn(), complete);
  motion.start(nav("/a/901"));
  motion.begin("/a#top");
  expect(complete).toHaveBeenCalledWith("/a/901");
  motion.start(nav("/a/902"));
  motion.pop("/a", "/boards");
  expect(complete).toHaveBeenLastCalledWith("/a/902");
});
it("导航外部store快照只在变更时替换，取消与注销对称；通知中重入仍以最新意图为准", () => {
  const motion = make();
  const subscriber = vi.fn();
  const remove = motion.subscribe(subscriber);
  motion.start(nav("/a/901"));
  const snapshot = motion.getSnapshot()!;
  expect(motion.getSnapshot()).toBe(snapshot);
  expect(Object.isFrozen(snapshot)).toBe(true);
  remove();
  const calls = subscriber.mock.calls.length;
  motion.start(nav("/a/902"));
  expect(subscriber).toHaveBeenCalledTimes(calls);
  let nested = false;
  motion.subscribe(() => {
    if (!nested && motion.getSnapshot()?.to === "/a/903") {
      nested = true;
      motion.start(nav("/a/904"));
    }
  });
  motion.start(nav("/a/903"));
  expect(motion.engine.current?.intent.to).toBe("/a/904");
});
it("onSkip 重入第三笔意图后，外层 prepare 不得覆盖最新导航", () => {
  const motion = make();
  motion.start(nav("/a/901"));
  motion.engine.register(
    { level: "global" },
    {
      onSkip(ctx, reason) {
        if (ctx.intent.to === "/a/901" && reason === "interrupted") motion.start(nav("/a/902"));
      },
    },
  );
  motion.start(nav("/a/903"));
  expect(motion.engine.current?.intent.to).toBe("/a/902");
  expect(document.documentElement.dataset.motionNav).toBe(String(motion.engine.current!.id));
});
it("取消旧导航的 hook 已发起恢复导航时，不得顺手释放恢复导航的所有权", () => {
  const motion = make();
  motion.start(nav("/a/901"));
  motion.engine.register(
    { level: "global" },
    {
      onSkip(ctx, reason) {
        if (ctx.intent.to === "/a/901" && reason === "transition-error")
          motion.start(nav("/a/902"));
      },
    },
  );
  motion.cancel("transition-error");
  expect(motion.engine.current?.intent.to).toBe("/a/902");
  expect(document.documentElement.dataset.motionNav).toBe(String(motion.engine.current!.id));
});
it("目标仍在加载时旧来源页的提交通知不能误取消它", () => {
  const motion = make();
  motion.start(nav("/a/901"));
  const id = motion.engine.current!.id;
  motion.committed("/a");
  expect(motion.engine.current?.id).toBe(id);
  expect(document.documentElement.dataset.motionNav).toBe(String(id));
});
it("显式普通方向覆盖圆形展开时，不能留下一个未实际展开的收起记录", () => {
  const motion = make();
  const card = document.createElement("div");
  card.setAttribute("data-vt-expand", "");
  const anchor = document.createElement("a");
  anchor.setAttribute("data-motion-direction", "push");
  card.append(anchor);
  motion.start({ from: "/f/3", to: "/t/1", anchor, point: { x: 100, y: 120 } });
  expect(document.documentElement.dataset.motionDirection).toBe("push");
  motion.start(nav("/f/3", "/t/1"));
  expect(document.documentElement.dataset.motionDirection).toBe("pop");
});
it("等待加载期间用户打开减少动态效果，参与者就绪时重新检查并skip", () => {
  let reduced = false;
  const motion = make({ reducedMotion: () => reduced });
  const skipped = vi.fn();
  motion.engine.register({ level: "global" }, { onSkip: skipped });
  motion.start(nav("/a/901"));
  const id = motion.engine.current!.id;
  reduced = true;
  motion.participate(id, { name: "page" } as ViewTransitionInstance, [])!();
  expect(skipped).toHaveBeenCalledWith(expect.anything(), "reduced-motion");
});
