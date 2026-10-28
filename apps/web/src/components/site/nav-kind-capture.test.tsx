import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavKindCapture } from "./nav-kind-capture";

let pathname = "/t/9";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const setNavKind = vi.hoisted(() => vi.fn());
vi.mock("@/lib/motion/nav-kind", async (orig) => {
  const actual = await orig<typeof import("@/lib/motion/nav-kind")>();
  return { ...actual, setNavKind };
});

beforeEach(() => {
  pathname = "/t/9";
  setNavKind.mockClear();
});
afterEach(() => window.history.replaceState(null, "", "/"));

describe("NavKindCapture（浏览器前进 / 后退的方向）", () => {
  it("popstate：按「当前页 → 地址栏新地址」的层级判定方向", () => {
    render(<NavKindCapture />);
    window.history.replaceState(null, "", "/f/3"); // 浏览器已把地址改成板块页
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(setNavKind).toHaveBeenCalledWith("pop"); // 主题(3) → 板块(2)
  });

  it("当前页随路径更新：提交到新页后再返回，以新页为起点", () => {
    const { rerender } = render(<NavKindCapture />);
    pathname = "/";
    rerender(<NavKindCapture />);
    window.history.replaceState(null, "", "/boards");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(setNavKind).toHaveBeenCalledWith("push"); // 首页(0) → 板块目录(1)
  });

  it("卸载后不再监听", () => {
    const { unmount } = render(<NavKindCapture />);
    unmount();
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(setNavKind).not.toHaveBeenCalled();
  });
});
