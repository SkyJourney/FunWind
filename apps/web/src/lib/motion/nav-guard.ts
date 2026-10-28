/**
 * 导航守卫（M10.7 Step 4a）：慢网络与失败兜底，不依赖 React，便于单测。
 *
 * 要解决的问题（站长要求）：慢网络下点击要**立刻有响应**（否则用户会重复点击）、等待要有占位、
 * 失败要提示「加载失败，请重试」并**留在动画前的页面**。
 *
 * 为什么需要自己兜底：Next 的软导航在 RSC 请求失败（断网 / 非 RSC 响应 / 超时）时，会退化成
 * **整页硬跳转**（控制台：`Falling back to browser navigation`），真实断网时用户会掉进浏览器错误页。
 * 本模块三层处理（验证见 docs/milestones/M10.7-streaming-motion.md §5.6）：
 *   1. 立即反馈：点击即记录「在途导航」→ 顶部进度条 + 被点元素 busy 态 + 同目标重复点击去重 + 慢提示；
 *   2. 失败检测：点击前离线直接提示不发起；导航型 RSC 请求超时中止；观察 RSC 请求的失败；
 *   3. 失败处理：用 Navigation API 的 navigate 事件拦下 Next 的整页回退（仅对「我们刚观察到失败的那个 URL」），
 *      页面留在原页，交给上层 toast 提示与重试。过渡动画只在页面提交时才开始，失败的导航没有动画，无需回滚。
 *
 * 局限：Navigation API 在 Chromium 全面可用，较新的 Safari / Firefox 才有；不支持时第 1 层与离线预检仍生效，
 * 但「服务端报错 / 超时」导致的整页回退拦不住，退化为 Next 默认行为。
 */

export interface NavGuardConfig {
  /** 点击后多久出现进度条（避免已缓存的瞬时导航闪一下） */
  progressDelayMs: number;
  /** 多久仍未完成就提示「网络较慢」 */
  slowAfterMs: number;
  /** 导航型 RSC 请求的超时：超过即中止并按失败处理 */
  failAfterMs: number;
}

export const NAV_GUARD_DEFAULTS: NavGuardConfig = {
  progressDelayMs: 80,
  slowAfterMs: 3000,
  failAfterMs: 15_000,
};

/** 不是页面路由的前缀：这些链接是文件 / 接口 / 静态资源，不会触发软导航，不应显示导航进度 */
const NON_PAGE_PREFIXES = ["/files/", "/api/", "/emoji/", "/brand/", "/_next/"];

export interface NavStatus {
  /** 有一次点击发起的导航在途 */
  pending: boolean;
  /** 进度条是否应显示（在途且已过 progressDelayMs） */
  showBar: boolean;
  /** 已超过慢阈值 */
  slow: boolean;
}

export interface NavFailure {
  /** 失败的目标（站内相对地址：pathname + search） */
  url: string;
  /** 由点击发起（false = 浏览器前进 / 后退等） */
  viaClick: boolean;
}

export interface NavGuardHandlers {
  /** 导航状态变化（进度条 / 慢提示的数据源） */
  onStatus(status: NavStatus): void;
  /** 点击前发现离线：已阻止本次导航 */
  onOffline(): void;
  /** 在途导航超过慢阈值 */
  onSlow(): void;
  /** 在途导航结束（成功 / 失败 / 被新导航取代）：用于收起慢提示 */
  onSettled(): void;
  /** 导航失败且整页回退已被拦下：页面仍在原页 */
  onFailure(failure: NavFailure): void;
}

export interface NavGuard {
  /** 页面已提交（地址变化）：结束在途导航 */
  complete(): void;
  /** 程序化发起（如 toast 的「重试」）：登记在途导航，调用方随后自行 router.push */
  begin(url: string): void;
  uninstall(): void;
}

export const NAV_IDLE: NavStatus = { pending: false, showBar: false, slow: false };

interface Pending {
  key: string;
  host: Element | null;
  timers: ReturnType<typeof setTimeout>[];
  status: NavStatus;
}

/** Navigation API 里本模块用到的最小子集（TypeScript 的 lib 尚未收录） */
interface NavigationLike {
  addEventListener(type: "navigate", listener: (e: NavigateEventLike) => void): void;
  removeEventListener(type: "navigate", listener: (e: NavigateEventLike) => void): void;
}
interface NavigateEventLike extends Event {
  destination: { url: string; sameDocument: boolean };
  cancelable: boolean;
  userInitiated: boolean;
}

/** 站内地址的比较键：pathname + search（忽略 hash 与 Next 附加的 _rsc 参数） */
export function navKeyOf(url: string, base: string): string {
  const u = new URL(url, base);
  u.searchParams.delete("_rsc");
  return `${u.pathname}${u.search}`;
}

function readHeader(input: RequestInfo | URL, init: RequestInit | undefined, name: string) {
  const fromInit = init?.headers ? new Headers(init.headers).get(name) : null;
  if (fromInit !== null) return fromInit;
  return input instanceof Request ? input.headers.get(name) : null;
}

/** 导航型 RSC 请求：带 RSC 头，且不是预取、不是 Server Action */
function isNavigationRsc(input: RequestInfo | URL, init?: RequestInit): boolean {
  return (
    readHeader(input, init, "rsc") === "1" &&
    readHeader(input, init, "next-router-prefetch") === null &&
    readHeader(input, init, "next-action") === null
  );
}

export function installNavGuard(
  handlers: NavGuardHandlers,
  config: NavGuardConfig = NAV_GUARD_DEFAULTS,
  win: Window & typeof globalThis = window,
): NavGuard {
  let pending: Pending | null = null;
  /** 最近一次观察到的导航型 RSC 失败：整页回退拦截只认它指向的 URL，避免误拦正常的整页跳转 */
  let lastFailure: { key: string; at: number } | null = null;
  const FAILURE_WINDOW_MS = 5000;

  const emit = (next: NavStatus) => handlers.onStatus(next);
  const currentKey = () => `${win.location.pathname}${win.location.search}`;

  /** 结束在途导航：清定时器与 busy 标记，复位状态 */
  const settle = () => {
    if (!pending) return;
    for (const t of pending.timers) clearTimeout(t);
    pending.host?.removeAttribute("data-nav-busy");
    pending = null;
    emit(NAV_IDLE);
    handlers.onSettled();
  };

  const begin = (key: string, host: Element | null) => {
    if (pending) settle(); // 新导航取代旧的（Next 也只认最后一次）
    const p: Pending = {
      key,
      host,
      timers: [],
      status: { pending: true, showBar: false, slow: false },
    };
    pending = p;
    host?.setAttribute("data-nav-busy", "");
    emit(p.status);
    p.timers.push(
      setTimeout(() => {
        if (pending !== p) return;
        p.status = { ...p.status, showBar: true };
        emit(p.status);
      }, config.progressDelayMs),
      setTimeout(() => {
        if (pending !== p) return;
        p.status = { ...p.status, slow: true };
        emit(p.status);
        handlers.onSlow();
      }, config.slowAfterMs),
      // 保底：请求超时本应先触发失败处理；若因任何原因没有，到点也要复位，不留悬挂的进度条
      setTimeout(() => {
        if (pending === p) settle();
      }, config.failAfterMs + 5000),
    );
  };

  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    const a = (e.target as Element | null)?.closest?.("a");
    if (!a) return;
    const href = a.getAttribute("href");
    if (
      !href ||
      !href.startsWith("/") ||
      href.startsWith("//") ||
      (a.target && a.target !== "_self") ||
      a.hasAttribute("download") ||
      a.origin !== win.location.origin ||
      NON_PAGE_PREFIXES.some((p) => a.pathname.startsWith(p))
    ) {
      return;
    }
    const key = `${a.pathname}${a.search}`;
    if (key === currentKey()) return; // 同一地址（含仅 hash 变化）：不是一次导航
    if (win.navigator.onLine === false) {
      e.preventDefault();
      handlers.onOffline();
      return;
    }
    if (pending?.key === key) {
      e.preventDefault(); // 同一目标还在加载：忽略重复点击，避免重复请求
      return;
    }
    // busy 标记落在「卡片」上（整张卡变暗比一行链接文字更有「被点中」的反馈）
    begin(key, a.closest("[data-nav-card], article, li, tr") ?? a);
  };

  // 保存原始引用，卸载时原样还原（还原 bind 之后的新函数会改变 window.fetch 的身份）
  const rawFetch = win.fetch;
  const origFetch = rawFetch.bind(win);
  const guardedFetch: typeof fetch = (input, init) => {
    if (!isNavigationRsc(input, init)) return origFetch(input, init);
    // 特性检测：AbortSignal.timeout（Chrome 103 / Safari 16 / Firefox 100）与 AbortSignal.any
    // （Chrome 116 / Safari 17.4 / Firefox 124）在老浏览器上不存在——此时不加超时、原样透传，
    // 绝不能因为兜底功能让正常导航抛错
    const existing = init?.signal;
    if (
      typeof AbortSignal.timeout !== "function" ||
      (existing && typeof AbortSignal.any !== "function")
    ) {
      return origFetch(input, init);
    }
    const url = input instanceof Request ? input.url : String(input);
    const key = navKeyOf(url, win.location.href);
    const timeout = AbortSignal.timeout(config.failAfterMs);
    const signal = existing ? AbortSignal.any([existing, timeout]) : timeout;
    const fail = () => {
      lastFailure = { key, at: Date.now() };
    };
    return origFetch(input, { ...init, signal }).then(
      (res) => {
        // Next 把「不是 RSC 内容类型」的响应（如网关的 502 HTML）也当作失败并整页回退
        if (!(res.headers.get("content-type") ?? "").startsWith("text/x-component")) fail();
        return res;
      },
      (err) => {
        fail();
        throw err;
      },
    );
  };
  win.fetch = guardedFetch;

  const nav = (win as unknown as { navigation?: NavigationLike }).navigation;
  const onNavigate = (e: NavigateEventLike) => {
    // Next 的软导航是同文档 pushState，不受影响；用户主动的整页跳转（点外链、手输地址）也不拦
    if (e.destination.sameDocument || !e.cancelable || e.userInitiated) return;
    const key = navKeyOf(e.destination.url, win.location.href);
    if (
      !lastFailure ||
      lastFailure.key !== key ||
      Date.now() - lastFailure.at > FAILURE_WINDOW_MS
    ) {
      return;
    }
    e.preventDefault(); // 拦下 Next 的整页回退：留在原页
    const viaClick = pending !== null;
    lastFailure = null;
    settle();
    handlers.onFailure({ url: key, viaClick });
  };
  nav?.addEventListener("navigate", onNavigate);
  document.addEventListener("click", onClick, true);

  return {
    complete: () => settle(),
    begin: (url) => begin(navKeyOf(url, win.location.href), null),
    uninstall: () => {
      settle();
      document.removeEventListener("click", onClick, true);
      nav?.removeEventListener("navigate", onNavigate);
      if (win.fetch === guardedFetch) win.fetch = rawFetch;
    },
  };
}
