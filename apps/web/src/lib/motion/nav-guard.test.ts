import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  installNavGuard,
  navKeyOf,
  NAV_GUARD_DEFAULTS,
  type NavGuard,
  type NavFailure,
  type NavGuardHandlers,
  type NavStatus,
} from "./nav-guard";

/** 假的 Navigation API：用 EventTarget 承载 navigate 事件 */
let fakeNavigation: EventTarget;
let originalFetch: typeof window.fetch;
let fetchStub: ReturnType<typeof vi.fn>;
let guard: NavGuard | null = null;
let statuses: NavStatus[];
let onOffline: Mock<() => void>;
let onSlow: Mock<() => void>;
let onSettled: Mock<() => void>;
let onFailure: Mock<(failure: NavFailure) => void>;

const lastStatus = () => statuses.at(-1)!;

function setup(config = NAV_GUARD_DEFAULTS) {
  statuses = [];
  onOffline = vi.fn<() => void>();
  onSlow = vi.fn<() => void>();
  onSettled = vi.fn<() => void>();
  onFailure = vi.fn<(failure: NavFailure) => void>();
  const handlers: NavGuardHandlers = {
    onStatus: (s) => statuses.push(s),
    onOffline: () => onOffline(),
    onSlow: () => onSlow(),
    onSettled: () => onSettled(),
    onFailure: (f) => onFailure(f),
  };
  guard = installNavGuard(handlers, config);
}

/** 渲染一张卡片并返回里面的链接 */
function addLink(href: string, attrs: Record<string, string> = {}) {
  const card = document.createElement("article");
  const a = document.createElement("a");
  a.setAttribute("href", href);
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  card.append(a);
  document.body.append(card);
  return { a, card };
}

/** 派发点击并返回事件（用 defaultPrevented 判断是否被守卫拦下） */
function click(a: Element, init: MouseEventInit = {}) {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  a.dispatchEvent(e);
  return e;
}

/** 派发 navigate 事件（Next 的整页回退 = 跨文档、脚本发起） */
function navigate(url: string, over: Record<string, unknown> = {}) {
  const e = Object.assign(new Event("navigate", { cancelable: true }), {
    destination: { url: new URL(url, "http://localhost").toString(), sameDocument: false },
    userInitiated: false,
    ...over,
  });
  fakeNavigation.dispatchEvent(e);
  return e;
}

/** 导航型 RSC 请求（Next 软导航发出的） */
const rscFetch = (url = "/t/1?_rsc=abc", headers: Record<string, string> = {}) =>
  window.fetch(url, { headers: { rsc: "1", ...headers } });

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  fakeNavigation = new EventTarget();
  Object.defineProperty(window, "navigation", { value: fakeNavigation, configurable: true });
  originalFetch = window.fetch;
  fetchStub = vi.fn(
    async () => new Response("ok", { headers: { "content-type": "text/x-component" } }),
  );
  window.fetch = fetchStub as unknown as typeof window.fetch;
  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
});
afterEach(() => {
  guard?.uninstall();
  guard = null;
  window.fetch = originalFetch;
  Reflect.deleteProperty(window, "navigation");
  vi.useRealTimers();
});

describe("navKeyOf", () => {
  it("取 pathname + search，忽略 hash 与 Next 附加的 _rsc 参数", () => {
    expect(navKeyOf("/t/1?page=2&_rsc=x#p9", "http://localhost/")).toBe("/t/1?page=2");
    expect(navKeyOf("http://localhost/f/3", "http://localhost/")).toBe("/f/3");
  });
});

describe("点击即反馈", () => {
  it("点击站内链接：进入在途状态，80ms 后出现进度条，被点的卡片置 busy；地址变化后复位", () => {
    setup();
    const { a, card } = addLink("/t/9");
    click(a);
    expect(lastStatus()).toEqual({ pending: true, showBar: false, slow: false });
    expect(card).toHaveAttribute("data-nav-busy");

    vi.advanceTimersByTime(NAV_GUARD_DEFAULTS.progressDelayMs);
    expect(lastStatus().showBar).toBe(true);

    guard!.complete();
    expect(lastStatus()).toEqual({ pending: false, showBar: false, slow: false });
    expect(card).not.toHaveAttribute("data-nav-busy");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("已缓存的瞬时导航不闪进度条：80ms 内完成则从未显示", () => {
    setup();
    click(addLink("/t/9").a);
    vi.advanceTimersByTime(40);
    guard!.complete();
    expect(statuses.some((s) => s.showBar)).toBe(false);
  });

  it("超过 3 秒仍未完成：标记 slow 并触发慢提示（只一次）", () => {
    setup();
    click(addLink("/t/9").a);
    vi.advanceTimersByTime(NAV_GUARD_DEFAULTS.slowAfterMs - 1);
    expect(onSlow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSlow).toHaveBeenCalledTimes(1);
    expect(lastStatus().slow).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it("同一目标还在加载时再次点击被忽略（去重，不重复请求）；点别的目标则取代旧的", () => {
    setup();
    const first = addLink("/t/9");
    expect(click(first.a).defaultPrevented).toBe(false);
    expect(click(first.a).defaultPrevented).toBe(true); // 重复点击被拦

    const second = addLink("/f/3");
    expect(click(second.a).defaultPrevented).toBe(false);
    expect(first.card).not.toHaveAttribute("data-nav-busy"); // 旧目标的 busy 被收回
    expect(second.card).toHaveAttribute("data-nav-busy");
    expect(onSettled).toHaveBeenCalledTimes(1); // 旧导航被取代时收起慢提示
  });

  it("保底：长时间无人结束也会复位，不留悬挂的进度条", () => {
    setup();
    click(addLink("/t/9").a);
    vi.advanceTimersByTime(NAV_GUARD_DEFAULTS.failAfterMs + 5000);
    expect(lastStatus().pending).toBe(false);
  });

  it.each([
    ["同一地址", "/", {}],
    ["仅 hash 变化", "/#p3", {}],
    ["外链", "https://example.com/x", {}],
    ["协议相对地址", "//example.com/x", {}],
    ["新标签页", "/t/9", { target: "_blank" }],
    ["下载链接", "/t/9", { download: "" }],
    ["附件文件", "/files/abc", {}],
    ["接口", "/api/foo", {}],
    ["表情图", "/emoji/1.gif", {}],
  ])("不处理：%s", (_name, href, attrs) => {
    setup();
    click(addLink(href, attrs).a);
    expect(statuses).toHaveLength(0);
  });

  it("带修饰键 / 非左键的点击不处理（用户要在新标签页打开）", () => {
    setup();
    const { a } = addLink("/t/9");
    click(a, { metaKey: true });
    click(a, { ctrlKey: true });
    click(a, { shiftKey: true });
    click(a, { button: 1 });
    expect(statuses).toHaveLength(0);
  });
});

describe("离线预检", () => {
  it("点击时已离线：阻止导航并提示，不进入在途状态", () => {
    setup();
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    const e = click(addLink("/t/9").a);
    expect(e.defaultPrevented).toBe(true);
    expect(onOffline).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveLength(0);
  });
});

describe("导航型 RSC 请求", () => {
  it("非 RSC 请求、预取、Server Action 原样透传，不加超时", async () => {
    setup();
    await window.fetch("/api/x");
    await window.fetch("/t/1", { headers: { rsc: "1", "next-router-prefetch": "1" } });
    await window.fetch("/t/1", { headers: { rsc: "1", "next-action": "abc" } });
    for (const call of fetchStub.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.signal).toBeUndefined();
    }
  });

  it("导航型 RSC 请求被加上超时信号", async () => {
    setup();
    await rscFetch();
    const init = fetchStub.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("请求自带 signal 时与超时合并：任一方中止都会中止请求", async () => {
    setup();
    const own = new AbortController();
    await window.fetch("/t/1?_rsc=a", { headers: { rsc: "1" }, signal: own.signal });
    const merged = (fetchStub.mock.calls[0]![1] as RequestInit).signal!;
    expect(merged.aborted).toBe(false);
    own.abort();
    expect(merged.aborted).toBe(true);
  });

  it("老浏览器没有 AbortSignal.timeout / any：原样透传，绝不抛错（兜底不能让正常导航失败）", async () => {
    setup();
    const timeout = AbortSignal.timeout;
    const any = AbortSignal.any;
    try {
      // @ts-expect-error 模拟老浏览器
      AbortSignal.timeout = undefined;
      await expect(rscFetch()).resolves.toBeInstanceOf(Response);
      expect((fetchStub.mock.calls.at(-1)![1] as RequestInit).signal).toBeUndefined();

      AbortSignal.timeout = timeout;
      // @ts-expect-error 模拟老浏览器
      AbortSignal.any = undefined;
      const own = new AbortController();
      await expect(
        window.fetch("/t/1?_rsc=a", { headers: { rsc: "1" }, signal: own.signal }),
      ).resolves.toBeInstanceOf(Response);
      expect((fetchStub.mock.calls.at(-1)![1] as RequestInit).signal).toBe(own.signal);
    } finally {
      AbortSignal.timeout = timeout;
      AbortSignal.any = any;
    }
  });

  it("uninstall 还原 fetch 并移除监听", async () => {
    setup();
    expect(window.fetch).not.toBe(fetchStub);
    const { a } = addLink("/t/9");
    guard!.uninstall();
    expect(window.fetch).toBe(fetchStub);
    click(a);
    expect(statuses.filter((s) => s.pending)).toHaveLength(0);
    guard = null;
  });
});

describe("失败检测与整页回退拦截", () => {
  /** 让一次导航型 RSC 请求失败，并等微任务落定 */
  async function failRsc(url = "/t/9?_rsc=abc") {
    fetchStub.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(rscFetch(url)).rejects.toThrow("Failed to fetch");
  }

  it("点击发起的导航：RSC 失败后 Next 回退整页跳转 → 被拦下，页面不离开，回调带 viaClick", async () => {
    setup();
    click(addLink("/t/9").a);
    await failRsc();
    const e = navigate("/t/9");
    expect(e.defaultPrevented).toBe(true);
    expect(onFailure).toHaveBeenCalledWith({ url: "/t/9", viaClick: true });
    expect(lastStatus().pending).toBe(false); // 进度条与 busy 一并收回
  });

  it("没有在途点击（浏览器前进 / 后退触发）：同样拦下，viaClick=false", async () => {
    setup();
    await failRsc("/f/3?_rsc=z");
    navigate("/f/3");
    expect(onFailure).toHaveBeenCalledWith({ url: "/f/3", viaClick: false });
  });

  it("响应不是 RSC 内容类型（如网关 502 的 HTML）也算失败", async () => {
    setup();
    fetchStub.mockResolvedValueOnce(
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    await rscFetch("/t/9?_rsc=abc");
    expect(navigate("/t/9").defaultPrevented).toBe(true);
  });

  it("响应是 RSC（含 404 页面）不算失败：之后的整页跳转不拦", async () => {
    setup();
    fetchStub.mockResolvedValueOnce(
      new Response("x", { status: 404, headers: { "content-type": "text/x-component" } }),
    );
    await rscFetch("/t/9?_rsc=abc");
    expect(navigate("/t/9").defaultPrevented).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("只拦「刚观察到失败」的那个 URL：别的整页跳转（如手动 location 赋值）不受影响", async () => {
    setup();
    await failRsc("/t/9?_rsc=abc");
    expect(navigate("/somewhere-else").defaultPrevented).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("用户主动的整页跳转、同文档导航、不可取消的导航都不拦", async () => {
    setup();
    await failRsc();
    expect(navigate("/t/9", { userInitiated: true }).defaultPrevented).toBe(false);
    expect(
      navigate("/t/9", { destination: { url: "http://localhost/t/9", sameDocument: true } })
        .defaultPrevented,
    ).toBe(false);
    const nonCancelable = Object.assign(new Event("navigate", { cancelable: false }), {
      destination: { url: "http://localhost/t/9", sameDocument: false },
      userInitiated: false,
    });
    fakeNavigation.dispatchEvent(nonCancelable);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("失败记录 5 秒后过期：之后同 URL 的整页跳转不再拦（可能是用户的新意图）", async () => {
    setup();
    await failRsc();
    vi.setSystemTime(Date.now() + 6000);
    expect(navigate("/t/9").defaultPrevented).toBe(false);
  });

  it("拦截只触发一次：失败记录用完即清", async () => {
    setup();
    await failRsc();
    expect(navigate("/t/9").defaultPrevented).toBe(true);
    expect(navigate("/t/9").defaultPrevented).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("浏览器不支持 Navigation API：不报错，仍可安装与卸载", () => {
    Reflect.deleteProperty(window, "navigation");
    expect(() => setup()).not.toThrow();
    click(addLink("/t/9").a);
    expect(lastStatus().pending).toBe(true);
  });
});

describe("程序化发起（重试）", () => {
  it("begin(url) 登记在途导航：进度条与慢提示照常，复位后收起", () => {
    setup();
    guard!.begin("/t/9?page=2");
    expect(lastStatus().pending).toBe(true);
    vi.advanceTimersByTime(NAV_GUARD_DEFAULTS.slowAfterMs);
    expect(onSlow).toHaveBeenCalledTimes(1);
    guard!.complete();
    expect(onSettled).toHaveBeenCalled();
  });
});
