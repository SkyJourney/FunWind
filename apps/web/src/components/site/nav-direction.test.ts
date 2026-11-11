import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDirection, releaseDirection, setDirection } from "./nav-direction";
import type { NavOrigin } from "./nav-geometry";

const root = () => document.documentElement;

describe("方向属性 <html data-motion-direction>", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearDirection();
    delete (document as { activeViewTransition?: unknown }).activeViewTransition;
  });
  afterEach(() => {
    clearDirection();
    vi.useRealTimers();
    delete (document as { activeViewTransition?: unknown }).activeViewTransition;
  });

  it("setDirection 写属性，后一次覆盖前一次；clearDirection 清除", () => {
    setDirection("push");
    expect(root().dataset.motionDirection).toBe("push");
    setDirection("pop");
    expect(root().dataset.motionDirection).toBe("pop");
    clearDirection();
    expect(root().dataset.motionDirection).toBeUndefined();
  });

  it("保底：导航从未提交时，15 秒后自动清除，不残留到下一次导航", () => {
    setDirection("push");
    vi.advanceTimersByTime(14_999);
    expect(root().dataset.motionDirection).toBe("push");
    vi.advanceTimersByTime(1);
    expect(root().dataset.motionDirection).toBeUndefined();
  });

  it("releaseDirection：没有进行中的过渡 → 立即清", () => {
    setDirection("push");
    releaseDirection();
    expect(root().dataset.motionDirection).toBeUndefined();
  });

  it("releaseDirection：有进行中的过渡 → 等它结束再清（动画选择器依赖该属性）", async () => {
    let finish!: () => void;
    (document as unknown as { activeViewTransition: unknown }).activeViewTransition = {
      finished: new Promise<void>((r) => (finish = r)),
    };
    setDirection("pop");
    releaseDirection();
    expect(root().dataset.motionDirection).toBe("pop"); // 过渡还在播，不能提前清
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(root().dataset.motionDirection).toBeUndefined();
  });

  it("过渡结束时若已被新导航写了别的方向，不能误清", async () => {
    let finish!: () => void;
    (document as unknown as { activeViewTransition: unknown }).activeViewTransition = {
      finished: new Promise<void>((r) => (finish = r)),
    };
    setDirection("push");
    releaseDirection();
    setDirection("pop"); // 新导航
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(root().dataset.motionDirection).toBe("pop");
  });

  it("旧链结束时即使新导航方向相同，也不能清除新一代写入", async () => {
    let finish!: () => void;
    (document as unknown as { activeViewTransition: unknown }).activeViewTransition = {
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    setDirection("push");
    releaseDirection();
    setDirection("push");
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(root().dataset.motionDirection).toBe("push");
  });

  it("没有方向属性时 releaseDirection 什么也不做", () => {
    expect(() => releaseDirection()).not.toThrow();
  });
});

describe("setDirection 带圆心（扩散 / 收起）", () => {
  beforeEach(() => clearDirection());
  afterEach(() => clearDirection());

  it("expand 把触点写到 <html> 的 --vt-x / --vt-y（取整），clearDirection 一并清掉", () => {
    const origin: NavOrigin = { x: 312.6, y: 140.2 };
    setDirection("expand", origin);
    expect(root().dataset.motionDirection).toBe("expand");
    expect(root().style.getPropertyValue("--vt-x")).toBe("313px");
    expect(root().style.getPropertyValue("--vt-y")).toBe("140px");
    clearDirection();
    expect(root().style.getPropertyValue("--vt-x")).toBe("");
    expect(root().dataset.motionDirection).toBeUndefined();
  });

  it("带终点半径时写 --vt-r（向上取整），清除时一并移除", () => {
    setDirection("expand", { x: 10, y: 20, r: 920.2 });
    expect(root().style.getPropertyValue("--vt-r")).toBe("921px");
    clearDirection();
    expect(root().style.getPropertyValue("--vt-r")).toBe("");
  });

  it("后一次不带圆心的导航会清掉上一次残留的圆心", () => {
    setDirection("expand", { x: 10, y: 20 });
    setDirection("push");
    expect(root().style.getPropertyValue("--vt-x")).toBe("");
  });
});
