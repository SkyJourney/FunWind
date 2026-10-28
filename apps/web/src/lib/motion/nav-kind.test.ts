import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearNavKind, kindBetween, releaseNavKind, setNavKind } from "./nav-kind";

const root = () => document.documentElement;

describe("kindBetween（层级表 → 方向）", () => {
  it("目标更深 → push；更浅 → pop；同层或未知 → fade", () => {
    expect(kindBetween("/", "/t/123")).toBe("push");
    expect(kindBetween("/t/123", "/")).toBe("pop");
    expect(kindBetween("/", "/boards")).toBe("push");
    expect(kindBetween("/boards", "/search")).toBe("fade");
    expect(kindBetween("/u/2", "/u/3")).toBe("fade");
    expect(kindBetween("/t/1", "/t/1")).toBe("fade");
  });

  it("板块页 → 主题页是前进（旧表里二者同为第 2 层，被判成同级淡入）", () => {
    expect(kindBetween("/f/2", "/t/9")).toBe("push");
    expect(kindBetween("/t/9", "/f/2")).toBe("pop");
    expect(kindBetween("/u/5", "/t/9")).toBe("push");
  });

  it("板块 / 用户页下的子页更深；栏目下的子页（会话）比栏目列表深一层", () => {
    expect(kindBetween("/f/2", "/f/2/new")).toBe("push");
    expect(kindBetween("/f/2/new", "/f/2")).toBe("pop");
    expect(kindBetween("/messages", "/messages/9")).toBe("push");
    expect(kindBetween("/messages/9", "/messages")).toBe("pop");
    expect(kindBetween("/me", "/messages")).toBe("fade");
  });

  it("未列出的路径取 fade，不抛错", () => {
    expect(() => kindBetween("/whatever", "/unknown")).not.toThrow();
    expect(kindBetween("/settings/avatar", "/")).toBe("pop");
    expect(kindBetween("/zzz", "/")).toBe("fade");
  });
});

describe("方向属性 <html data-nav>", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearNavKind();
    delete (document as { activeViewTransition?: unknown }).activeViewTransition;
  });
  afterEach(() => {
    clearNavKind();
    vi.useRealTimers();
    delete (document as { activeViewTransition?: unknown }).activeViewTransition;
  });

  it("setNavKind 写属性，后一次覆盖前一次；clearNavKind 清除", () => {
    setNavKind("push");
    expect(root().dataset.nav).toBe("push");
    setNavKind("pop");
    expect(root().dataset.nav).toBe("pop");
    clearNavKind();
    expect(root().dataset.nav).toBeUndefined();
  });

  it("保底：导航从未提交时，15 秒后自动清除，不残留到下一次导航", () => {
    setNavKind("push");
    vi.advanceTimersByTime(14_999);
    expect(root().dataset.nav).toBe("push");
    vi.advanceTimersByTime(1);
    expect(root().dataset.nav).toBeUndefined();
  });

  it("releaseNavKind：没有进行中的过渡 → 立即清", () => {
    setNavKind("push");
    releaseNavKind();
    expect(root().dataset.nav).toBeUndefined();
  });

  it("releaseNavKind：有进行中的过渡 → 等它结束再清（动画选择器依赖该属性）", async () => {
    let finish!: () => void;
    (document as unknown as { activeViewTransition: unknown }).activeViewTransition = {
      finished: new Promise<void>((r) => (finish = r)),
    };
    setNavKind("pop");
    releaseNavKind();
    expect(root().dataset.nav).toBe("pop"); // 过渡还在播，不能提前清
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(root().dataset.nav).toBeUndefined();
  });

  it("过渡结束时若已被新导航写了别的方向，不能误清", async () => {
    let finish!: () => void;
    (document as unknown as { activeViewTransition: unknown }).activeViewTransition = {
      finished: new Promise<void>((r) => (finish = r)),
    };
    setNavKind("push");
    releaseNavKind();
    setNavKind("pop"); // 新导航
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(root().dataset.nav).toBe("pop");
  });

  it("没有方向属性时 releaseNavKind 什么也不做", () => {
    expect(() => releaseNavKind()).not.toThrow();
  });
});
