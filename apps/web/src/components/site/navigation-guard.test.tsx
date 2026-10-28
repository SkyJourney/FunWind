import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavGuardHandlers } from "@/lib/motion/nav-guard";
import { NavigationGuard } from "./navigation-guard";

const push = vi.fn();
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  message: vi.fn(),
  dismiss: vi.fn(),
}));
let pathname = "/";
let search = "";

const navKind = vi.hoisted(() => ({
  setNavKind: vi.fn(),
  clearNavKind: vi.fn(),
  releaseNavKind: vi.fn(),
}));
vi.mock("@/lib/motion/nav-kind", async (orig) => {
  const actual = await orig<typeof import("@/lib/motion/nav-kind")>();
  return { ...actual, ...navKind };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("sonner", () => ({ toast }));

/** 用假的守卫替换核心：捕获 handlers，由测试主动触发各种场景 */
const guard = vi.hoisted(() => ({
  handlers: null as unknown,
  complete: vi.fn(),
  begin: vi.fn(),
  uninstall: vi.fn(),
}));
vi.mock("@/lib/motion/nav-guard", async (orig) => {
  const actual = await orig<typeof import("@/lib/motion/nav-guard")>();
  return {
    ...actual,
    installNavGuard: (handlers: NavGuardHandlers) => {
      guard.handlers = handlers;
      return { complete: guard.complete, begin: guard.begin, uninstall: guard.uninstall };
    },
  };
});

const h = () => guard.handlers as NavGuardHandlers;

beforeEach(() => {
  pathname = "/";
  search = "";
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => h().onStatus({ pending: false, showBar: false, slow: false }));
});

describe("NavigationGuard", () => {
  it("挂载时安装守卫，卸载时卸载", () => {
    const { unmount } = render(<NavigationGuard />);
    expect(guard.handlers).not.toBeNull();
    unmount();
    expect(guard.uninstall).toHaveBeenCalledTimes(1);
  });

  it("进度条只在 showBar 时渲染，可访问性标注为 progressbar", () => {
    render(<NavigationGuard />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    act(() => h().onStatus({ pending: true, showBar: false, slow: false }));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument(); // 80ms 内不闪
    act(() => h().onStatus({ pending: true, showBar: true, slow: false }));
    expect(screen.getByRole("progressbar", { name: "页面加载中" })).toBeInTheDocument();
  });

  it("慢提示常驻不自动消失，导航结束时收起", () => {
    render(<NavigationGuard />);
    act(() => h().onSlow());
    expect(toast.message).toHaveBeenCalledWith("网络较慢，仍在加载…", {
      id: "nav-slow",
      duration: Infinity,
    });
    act(() => h().onSettled());
    expect(toast.dismiss).toHaveBeenCalledWith("nav-slow");
  });

  it("确认发起导航时按层级表写页面过渡方向（查询串不参与判定）", () => {
    render(<NavigationGuard />);
    act(() => h().onStart({ from: "/f/3?page=2", to: "/t/9" }));
    expect(navKind.setNavKind).toHaveBeenLastCalledWith("push");
    act(() => h().onStart({ from: "/t/9", to: "/f/3?page=2" }));
    expect(navKind.setNavKind).toHaveBeenLastCalledWith("pop");
    act(() => h().onStart({ from: "/boards", to: "/search?q=x" }));
    expect(navKind.setNavKind).toHaveBeenLastCalledWith("fade");
  });

  it("导航失败：清掉已写的方向，避免残留到下一次导航", () => {
    render(<NavigationGuard />);
    act(() => h().onFailure({ url: "/t/9", viaClick: true }));
    expect(navKind.clearNavKind).toHaveBeenCalledTimes(1);
  });

  it("离线提示", () => {
    render(<NavigationGuard />);
    act(() => h().onOffline());
    expect(toast.error).toHaveBeenCalledWith(
      "网络已断开，请检查连接后重试",
      expect.objectContaining({ id: "nav-failed" }),
    );
  });

  it("点击发起的导航失败：toast「加载失败，请重试」，重试 = 登记在途 + 软导航到同一地址", () => {
    render(<NavigationGuard />);
    act(() => h().onFailure({ url: "/t/9?page=2", viaClick: true }));
    const [text, opts] = toast.error.mock.calls[0]!;
    expect(text).toBe("加载失败，请重试");
    expect(opts.action.label).toBe("重试");
    opts.action.onClick();
    expect(guard.begin).toHaveBeenCalledWith("/t/9?page=2");
    expect(push).toHaveBeenCalledWith("/t/9?page=2");
  });

  it("浏览器前进 / 后退失败：重试 = 整页加载一次，让地址栏与页面一致", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<NavigationGuard />);
    act(() => h().onFailure({ url: "/f/3", viaClick: false }));
    toast.error.mock.calls[0]![1].action.onClick();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("地址变化 = 页面已提交：通知守卫结束在途导航；查询参数变化同样算", () => {
    const { rerender } = render(<NavigationGuard />);
    guard.complete.mockClear();
    navKind.releaseNavKind.mockClear();
    pathname = "/t/9";
    rerender(<NavigationGuard />);
    expect(guard.complete).toHaveBeenCalledTimes(1);
    expect(navKind.releaseNavKind).toHaveBeenCalledTimes(1); // 当次过渡结束后释放方向属性
    search = "page=2";
    rerender(<NavigationGuard />);
    expect(guard.complete).toHaveBeenCalledTimes(2);
  });
});
