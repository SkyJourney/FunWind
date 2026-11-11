import { act, cleanup, render, screen } from "@testing-library/react";
import { useLayoutEffect, type ViewTransitionInstance } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavGuardHandlers } from "@/lib/motion/nav-guard";
import { resetExpandRecord } from "@/lib/motion/nav-kind";
import { NavigationGuard } from "./navigation-guard";
import { createPageMotion, type PageMotion, type PageNavigation } from "./page-motion";

const push = vi.fn();
const replace = vi.fn();
const router = { push, replace };
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  message: vi.fn(),
  dismiss: vi.fn(),
}));
let pathname = "/";
let search = "";
let motion: PageMotion;

const navKind = vi.hoisted(() => ({
  setNavKind: vi.fn(),
  clearNavKind: vi.fn(),
  releaseNavKind: vi.fn(),
}));
vi.mock("@/lib/motion/nav-kind", async (orig) => {
  const actual = await orig<typeof import("@/lib/motion/nav-kind")>();
  return {
    ...actual,
    setNavKind: navKind.setNavKind.mockImplementation(actual.setNavKind),
    clearNavKind: navKind.clearNavKind.mockImplementation(actual.clearNavKind),
    releaseNavKind: navKind.releaseNavKind.mockImplementation(actual.releaseNavKind),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("./motion-provider", () => ({ useSiteMotion: () => motion }));

/** 只替换外部守卫：捕获 handlers，页面动效与提交代次仍使用真实实现。 */
const guard = vi.hoisted(() => ({
  handlers: null as unknown,
  install: vi.fn(),
  complete: vi.fn<(url?: string) => void>(),
  begin: vi.fn<(url: string) => boolean>(),
  uninstall: vi.fn(),
}));
vi.mock("@/lib/motion/nav-guard", async (orig) => {
  const actual = await orig<typeof import("@/lib/motion/nav-guard")>();
  return {
    ...actual,
    installNavGuard: (handlers: NavGuardHandlers) => {
      guard.install(handlers);
      guard.handlers = handlers;
      return { complete: guard.complete, begin: guard.begin, uninstall: guard.uninstall };
    },
  };
});

const h = () => guard.handlers as NavGuardHandlers;
const currentUrl = () => `${pathname}${search ? `?${search}` : ""}`;
// 仅用来验证实例透传；本文件不访问 ReactDOM 增强的伪元素成员。
const instance = { name: "page-transition" } as ViewTransitionInstance;

/** 同步路由 mock 与地址栏，避免把不一致的来源误判成重定向提交。 */
function showUrl(url: string) {
  window.history.replaceState(null, "", url);
  pathname = window.location.pathname;
  search = window.location.search.slice(1);
}

function start(to: string) {
  act(() => h().onStart({ from: currentUrl(), to, anchor: null, point: null }));
}

function finishTransition(id: number) {
  const remove = motion.participate(id, instance, []);
  expect(remove).toBeTypeOf("function");
  expect(motion.engine.current).toMatchObject({ id, phase: "ready" });
  if (typeof remove === "function") act(remove);
}

/** 在第一次被动 effect 绑定守卫前发起导航，保留旧 render 的真实提交顺序。 */
function BeginOnLayout({
  to,
  onRequest,
}: {
  to: string;
  onRequest: (request: PageNavigation | undefined) => void;
}) {
  useLayoutEffect(() => {
    motion.begin(to);
    onRequest(motion.getSnapshot());
  }, [to, onRequest]);
  return null;
}

beforeEach(() => {
  showUrl("/");
  vi.clearAllMocks();
  guard.handlers = null;
  guard.begin.mockReset().mockImplementation((url) => {
    h().onStart({ from: currentUrl(), to: url, anchor: null, point: null });
    return true;
  });
  motion = createPageMotion({
    supported: () => true,
    reducedMotion: () => false,
    schedule: () => () => {},
  });
});
afterEach(() => {
  if (guard.handlers) {
    act(() => h().onStatus({ pending: false, showBar: false, slow: false }));
  }
  cleanup();
  motion.cancel("disposed");
  motion.engine.dispose();
  resetExpandRecord();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NavigationGuard", () => {
  it("挂载时安装守卫，无关重渲染不重复安装，卸载时注销绑定与守卫", () => {
    const { rerender, unmount } = render(<NavigationGuard />);
    expect(guard.handlers).not.toBeNull();
    expect(guard.install).toHaveBeenCalledOnce();
    rerender(<NavigationGuard />);
    act(() => h().onStatus({ pending: true, showBar: true, slow: false }));
    expect(guard.install).toHaveBeenCalledOnce();
    expect(guard.uninstall).not.toHaveBeenCalled();
    unmount();
    expect(guard.uninstall).toHaveBeenCalledOnce();
    motion.begin("/t/9");
    expect(guard.begin).not.toHaveBeenCalled();
    expect(motion.getSnapshot()?.to).toBe("/t/9");
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

  it("导航按层级写方向；试点 plan 的无圆心是 undefined，兼容链是 null", () => {
    render(<NavigationGuard />);
    for (const [from, to, direction, origin] of [
      ["/f/3?page=2", "/t/9", "push", undefined],
      ["/t/9", "/f/3?page=2", "pop", undefined],
      ["/f/3", "/u/9?x=1", "fade", null],
      ["/boards", "/search?q=x", "tab-next", null],
    ] as const) {
      showUrl(from);
      start(to);
      expect(navKind.setNavKind).toHaveBeenLastCalledWith(
        direction,
        origin,
        document.documentElement,
      );
      expect(document.documentElement).toHaveAttribute("data-nav", direction);
      expect(motion.getSnapshot()).toMatchObject({ from, to });
      expect(guard.complete).not.toHaveBeenCalled();
    }
  });

  it("内容卡片点进主题页：写 expand 与触点圆心", () => {
    document.body.innerHTML = '<article data-vt-expand><a href="/t/9">x</a></article>';
    render(<NavigationGuard />);
    act(() =>
      h().onStart({
        from: currentUrl(),
        to: "/t/9",
        anchor: document.querySelector("a"),
        point: { x: 321, y: 123 },
      }),
    );
    expect(navKind.setNavKind).toHaveBeenLastCalledWith(
      "expand",
      expect.objectContaining({ x: 321, y: 123 }), // jsdom 无包装盒子：pageTop = 0
      document.documentElement,
    );
    expect(motion.engine.current?.plan).toMatchObject({
      direction: "expand",
      origin: { x: 321, y: 123 },
    });
  });

  it("失败之后、下一次导航之前重置当前页一次；一次失败只重置一次，没有失败不重置", () => {
    showUrl("/f/3?page=2");
    render(<NavigationGuard />);
    start("/t/9");
    expect(replace).not.toHaveBeenCalled();

    act(() => h().onFailure({ url: "/t/9", viaClick: true }));
    expect(replace).not.toHaveBeenCalled(); // 失败当下不重置，避免循环刷新
    expect(motion.getSnapshot()).toBeUndefined();

    start("/t/9");
    // 路由器的规范地址可能已经是失败目标，必须重置当前健康页面而不是刷新失败地址。
    expect(replace).toHaveBeenCalledExactlyOnceWith("/f/3?page=2", { scroll: false });
    start("/t/9");
    expect(replace).toHaveBeenCalledOnce();
  });

  it("导航失败：清掉已写的方向，避免残留到下一次导航", () => {
    render(<NavigationGuard />);
    start("/t/9");
    expect(document.documentElement).toHaveAttribute("data-nav", "push");
    act(() => h().onFailure({ url: "/t/9", viaClick: true }));
    expect(navKind.clearNavKind).toHaveBeenCalledExactlyOnceWith(document.documentElement);
    expect(document.documentElement).not.toHaveAttribute("data-nav");
    expect(motion.engine.current).toBeUndefined();
    expect(motion.getSnapshot()).toBeUndefined();
  });

  it("离线提示", () => {
    render(<NavigationGuard />);
    act(() => h().onOffline());
    expect(toast.error).toHaveBeenCalledWith(
      "网络已断开，请检查连接后重试",
      expect.objectContaining({ id: "nav-failed" }),
    );
  });

  it("点击导航失败：显示重试提示，重试先登记在途再软导航到同一地址", () => {
    render(<NavigationGuard />);
    act(() => h().onFailure({ url: "/t/9?page=2", viaClick: true }));
    const [text, opts] = toast.error.mock.calls[0]!;
    expect(text).toBe("加载失败，请重试");
    expect(opts.action.label).toBe("重试");
    act(() => opts.action.onClick());
    expect(guard.begin).toHaveBeenCalledExactlyOnceWith("/t/9?page=2");
    expect(push).toHaveBeenCalledExactlyOnceWith("/t/9?page=2");
    expect(guard.begin.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0]!);
    expect(motion.getSnapshot()).toMatchObject({ from: "/", to: "/t/9?page=2" });
  });

  it("重试的 guard.begin 返回 false 代表已被更新意图取代，不再派发旧 router.push", () => {
    render(<NavigationGuard />);
    act(() => h().onFailure({ url: "/t/9?page=2", viaClick: true }));
    guard.begin.mockImplementationOnce(() => {
      h().onStart({ from: currentUrl(), to: "/a/902", anchor: null, point: null });
      return false;
    });
    act(() => toast.error.mock.calls[0]![1].action.onClick());
    expect(guard.begin).toHaveBeenCalledExactlyOnceWith("/t/9?page=2");
    expect(push).not.toHaveBeenCalled();
    expect(motion.getSnapshot()).toMatchObject({ from: "/", to: "/a/902" });
    expect(motion.engine.current?.intent.to).toBe("/a/902");
  });

  it("浏览器前进 / 后退失败：重试整页加载一次，让地址栏与页面一致", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<NavigationGuard />);
    act(() => h().onFailure({ url: "/f/3", viaClick: false }));
    act(() => toast.error.mock.calls[0]![1].action.onClick());
    expect(reload).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
    expect(guard.begin).not.toHaveBeenCalled();
  });

  it("真实在途请求按捕获 epoch 提交目标 key；试点等参与者 cleanup 才清方向，query 也须先有请求", () => {
    showUrl("/f/3?page=2");
    const committed = vi.spyOn(motion, "committed");
    const { rerender } = render(<NavigationGuard />);
    expect(guard.complete).not.toHaveBeenCalled();
    expect(navKind.releaseNavKind).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();

    start("/t/9");
    const request = motion.getSnapshot()!;
    const id = motion.engine.current!.id;
    expect(request).toEqual({
      epoch: expect.any(Number),
      from: "/f/3?page=2",
      to: "/t/9",
      obsolete: [],
    });
    expect(committed).toHaveBeenLastCalledWith("/f/3?page=2", request.epoch);
    expect(motion.getSnapshot()).toBe(request);
    expect(guard.complete).not.toHaveBeenCalled();

    showUrl("/t/9");
    rerender(<NavigationGuard />);
    expect(committed).toHaveBeenLastCalledWith("/t/9", request.epoch);
    expect(guard.complete).toHaveBeenCalledExactlyOnceWith(request.to);
    expect(motion.getSnapshot()).toBeUndefined();
    expect(navKind.releaseNavKind).not.toHaveBeenCalled();
    expect(navKind.clearNavKind).not.toHaveBeenCalled();
    expect(document.documentElement).toHaveAttribute("data-nav", "push");
    expect(document.documentElement).toHaveAttribute("data-motion-nav", String(id));
    const remove = motion.participate(id, instance, []);
    expect(remove).toBeTypeOf("function");
    expect(motion.engine.current).toMatchObject({ id, phase: "ready" });
    expect(document.documentElement).toHaveAttribute("data-nav", "push");
    if (typeof remove === "function") act(remove);
    expect(document.documentElement).not.toHaveAttribute("data-nav");
    expect(document.documentElement).not.toHaveAttribute("data-motion-nav");
    expect(navKind.releaseNavKind).not.toHaveBeenCalled();

    start("/t/9?page=2");
    const query = motion.getSnapshot()!;
    expect(query).toEqual({
      epoch: expect.any(Number),
      from: "/t/9",
      to: "/t/9?page=2",
      obsolete: [],
    });
    expect(query.epoch).toBeGreaterThan(request.epoch);
    expect(committed).toHaveBeenLastCalledWith("/t/9", query.epoch);
    expect(guard.complete).toHaveBeenCalledOnce();
    expect(motion.engine.current).toBeUndefined();
    showUrl("/t/9?page=2");
    rerender(<NavigationGuard />);
    expect(committed).toHaveBeenLastCalledWith("/t/9?page=2", query.epoch);
    expect(guard.complete.mock.calls).toEqual([[request.to], [query.to]]);
    expect(motion.getSnapshot()).toBeUndefined();
    expect(document.documentElement).not.toHaveAttribute("data-nav");
    expect(guard.install).toHaveBeenCalledOnce();
  });

  it("首次 layout effect 发起新请求后，旧 render 的 passive effect 仍携带旧 epoch，不能结清新请求", () => {
    showUrl("/a");
    motion.start({ from: currentUrl(), to: "/a/901", anchor: null, point: null });
    const old = motion.getSnapshot()!;
    showUrl("/a/901");
    const committed = vi.spyOn(motion, "committed");
    const onRequest = vi.fn<(request: PageNavigation | undefined) => void>();
    const tree = () => (
      <>
        <NavigationGuard />
        <BeginOnLayout to="/a/902" onRequest={onRequest} />
      </>
    );
    const { rerender } = render(tree());
    const latest = onRequest.mock.calls[0]![0]!;
    expect(latest).toEqual({
      epoch: expect.any(Number),
      from: "/a/901",
      to: "/a/902",
      obsolete: [old.to],
    });
    expect(latest.epoch).toBeGreaterThan(old.epoch);
    expect(committed).toHaveBeenCalledWith("/a/901", old.epoch);
    expect(committed.mock.results[0]!.value).toBe(false);
    expect(committed).toHaveBeenLastCalledWith("/a/901", latest.epoch);
    expect(motion.getSnapshot()).toBe(latest);
    expect(motion.engine.current).toMatchObject({ intent: { to: latest.to }, phase: "committed" });
    expect(guard.complete).not.toHaveBeenCalled();
    expect(guard.begin).not.toHaveBeenCalled(); // layout effect 执行时尚未绑定外部守卫
    expect(guard.install).toHaveBeenCalledOnce();

    const id = motion.engine.current!.id;
    showUrl(latest.to);
    rerender(tree());
    expect(committed).toHaveBeenLastCalledWith(latest.to, latest.epoch);
    expect(guard.complete).toHaveBeenCalledExactlyOnceWith(latest.to);
    expect(motion.getSnapshot()).toBeUndefined();
    expect(document.documentElement).toHaveAttribute("data-nav", "fade");
    finishTransition(id);
    expect(document.documentElement).not.toHaveAttribute("data-nav");
  });

  it("旧目标 URL 晚到不能认领更新请求，只有最新目标提交才能 complete", () => {
    const committed = vi.spyOn(motion, "committed");
    const { rerender } = render(<NavigationGuard />);
    start("/t/1");
    const old = motion.getSnapshot()!;
    start("/t/2");
    const latest = motion.getSnapshot()!;
    const id = motion.engine.current!.id;
    expect(latest.epoch).toBeGreaterThan(old.epoch);
    expect(latest.obsolete).toEqual([old.to]);

    showUrl(old.to);
    rerender(<NavigationGuard />);
    expect(committed).toHaveBeenLastCalledWith(old.to, latest.epoch);
    expect(motion.getSnapshot()).toBe(latest);
    expect(motion.engine.current?.id).toBe(id);
    expect(guard.complete).not.toHaveBeenCalled();
    expect(navKind.releaseNavKind).not.toHaveBeenCalled();

    showUrl(latest.to);
    rerender(<NavigationGuard />);
    expect(committed).toHaveBeenLastCalledWith(latest.to, latest.epoch);
    expect(guard.complete).toHaveBeenCalledExactlyOnceWith(latest.to);
    expect(motion.getSnapshot()).toBeUndefined();
    expect(document.documentElement).toHaveAttribute("data-nav", "push");
    finishTransition(id);
    expect(document.documentElement).not.toHaveAttribute("data-nav");
  });
});
