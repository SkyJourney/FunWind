// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackToTop } from "./back-to-top";

/**
 * BackToTop 单测（M16.1 Step 4 补齐 M16 残值）：M16 审查报告曾称「组件单测已覆盖 reduce 分支」，
 * 实际本文件此前不存在。reduce 是**点击时的 JS 参数分支**（behavior auto），
 * 不是 CSS 动画名，只能断言 scrollTo 的入参。
 */
const setScrollY = (value: number) =>
  Object.defineProperty(window, "scrollY", { configurable: true, value });
const reduced = (matches: boolean) => {
  window.matchMedia = vi.fn().mockReturnValue({ matches }) as never;
};
// 隐藏态带 aria-hidden，getByRole 查不到（读屏口径正确）——按属性定位，与 M16 E2E 同款
const button = () => document.querySelector<HTMLButtonElement>('button[aria-label="回到顶部"]')!;
const scroll = () =>
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });

let scrollTo: ReturnType<typeof vi.fn>;
beforeEach(() => {
  scrollTo = vi.fn();
  Object.defineProperty(window, "scrollTo", { configurable: true, value: scrollTo });
  setScrollY(0);
  reduced(false);
});
afterEach(() => {
  setScrollY(0);
  vi.restoreAllMocks();
});

describe("BackToTop 显隐（ReplyFab 同款常驻口径）", () => {
  it("页顶：隐藏态 = opacity-0 + pointer-events-none + inert + aria-hidden（不可见即不可点/不可聚焦）", () => {
    render(<BackToTop />);
    const el = button();
    expect(el.className).toContain("opacity-0");
    expect(el.className).toContain("pointer-events-none");
    expect(el).toHaveAttribute("inert");
    expect(el).toHaveAttribute("aria-hidden", "true");
  });

  it("滚过一屏：显示态，inert 与 aria-hidden 撤下", () => {
    render(<BackToTop />);
    setScrollY(window.innerHeight + 10);
    scroll();
    const el = button();
    expect(el.className).toContain("opacity-100");
    expect(el.className).not.toContain("pointer-events-none");
    expect(el).not.toHaveAttribute("inert");
    expect(el).toHaveAttribute("aria-hidden", "false");
  });

  it("恰好一屏不出现（严格大于）", () => {
    render(<BackToTop />);
    setScrollY(window.innerHeight);
    scroll();
    expect(button().className).toContain("opacity-0");
  });

  it("回顶后重新隐藏", () => {
    render(<BackToTop />);
    setScrollY(2000);
    scroll();
    expect(button().className).toContain("opacity-100");
    setScrollY(0);
    scroll();
    expect(button().className).toContain("opacity-0");
  });

  it("display 恒不切换：base hidden + md:flex 同时在（移动端不参与，过渡才有起始态）", () => {
    render(<BackToTop />);
    const cls = button().className;
    expect(cls).toContain("hidden");
    expect(cls).toContain("md:flex");
    expect(cls).not.toContain("md:hidden");
    setScrollY(2000);
    scroll();
    expect(button().className).toContain("md:flex"); // 显示后依然不切 display
  });

  it("布局型/位移过渡带 motion-reduce 归零", () => {
    render(<BackToTop />);
    expect(button().className).toContain("motion-reduce:transition-none");
  });
});

describe("BackToTop 点击行为与 reduce 降级", () => {
  it("正常动效：平滑回顶（behavior smooth）", async () => {
    const user = userEvent.setup();
    render(<BackToTop />);
    setScrollY(2000);
    scroll();
    await user.click(button());
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("reduce：瞬时跳转（behavior auto）——参数分支，不是动画名", async () => {
    reduced(true);
    const user = userEvent.setup();
    render(<BackToTop />);
    setScrollY(2000);
    scroll();
    await user.click(button());
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });

  it("reduce 偏好在每次点击时实时读取：会话中途切换立即生效，不是挂载时固化", async () => {
    const user = userEvent.setup();
    render(<BackToTop />);
    setScrollY(2000);
    scroll();
    await user.click(button());
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" });
    reduced(true); // 用户中途打开「减弱动态效果」
    await user.click(button());
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
  });
});

describe("BackToTop 生命周期", () => {
  it("卸载时以同一函数引用摘掉 scroll 监听（真断言：删掉 cleanup 就会红）", () => {
    // 不能断言「卸载后 className 不变」——React 对已卸载组件 setState 本就是 no-op，
    // 那样即使删掉 removeEventListener 也照样绿（Step 4.5 审查查出的永真断言）。
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<BackToTop />);
    const registered = add.mock.calls.filter(([type]) => type === "scroll");
    expect(registered).toHaveLength(1);
    unmount();
    const removed = remove.mock.calls.filter(([type]) => type === "scroll");
    expect(removed).toHaveLength(1);
    expect(removed[0]![1]).toBe(registered[0]![1]); // 必须是同一个函数引用才摘得掉
  });
});
