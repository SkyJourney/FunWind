/**
 * 路由方向（M10.7 Step 4b）：把「这次导航是前进还是返回」写到 <html data-nav>，页面过渡的 CSS 据此选动画
 * （globals.css 的 `.fw-page`）。
 *
 * 为什么用 <html> 上的属性而不是 <Link transitionTypes>：
 *  - 站里有几百处链接，不必逐个加属性；
 *  - 浏览器前进 / 后退（popstate）不带过渡类型，只能靠属性补方向（M10.7 §5.5 验证 5）；
 *  - 点击与 popstate 走同一套机制。
 * 属性要撑到页面真正提交（慢网络下导航会挂起数秒），所以不能点击后定时清除：
 * 在「地址变化且当次过渡结束」之后才清（releaseNavKind），另有保底超时。
 */
export type NavKind = "push" | "pop" | "fade" | "expand" | "collapse" | "tab-next" | "tab-prev";

/**
 * 扩散 / 收起的圆：圆心（相对 [data-fw-page] 包装盒子，px）与终点半径（px，覆盖视口所需的最小值）。
 * 半径必须精确：用过大的值（如 150vmax）加前快后慢的缓动，圆会在最初一百多毫秒就盖满视口，
 * 肉眼看起来就是淡入而不是扩散。
 */
export interface NavOrigin {
  x: number;
  y: number;
  /** 终点半径；缺省时 CSS 回退到 150vmax */
  r?: number;
}

/**
 * 层级表（站点信息架构）：0 首页 → 1 一级栏目 → 2 板块 / 用户 / 栏目下的子页 → 3 主题与更深的详情。
 * 目标比当前更深 = 前进（push），更浅 = 返回（pop），同层或未知 = fade。
 */
function rank(pathname: string): number | null {
  if (pathname === "/") return 0;
  // 板块与用户页：/f/{fid}、/u/{uid} 是第 2 层；其下的子页（/f/{fid}/new 发帖）更深
  if (/^\/(f|u)\/[^/]+$/.test(pathname)) return 2;
  if (/^\/(f|u)\/[^/]+\//.test(pathname)) return 3;
  // 主题详情 /t/{tid}：第 3 层
  if (/^\/t\/[^/]+/.test(pathname)) return 3;
  if (
    /^\/(boards|follows|search|messages|notifications|points|me|admin|submit|settings)(\/|$)/.test(
      pathname,
    )
  ) {
    return pathname.split("/").filter(Boolean).length > 1 ? 2 : 1;
  }
  return null;
}

/**
 * Tab 根页面的左右顺序（底部 Tab 与桌面顶栏的排列：首页 → 板块 → 动态 → 搜索 → 发帖 → 消息 → 通知 → 我的 → 登录）。
 * 一个访客 / 登录用户实际看到的 Tab 是其中的子集，但相对顺序一致，所以按这张表比较左右即可。
 * 只认**根页面本身**（精确匹配）：板块页 /f/3、主题页、个人页等不属于 Tab 切换。
 */
const TAB_ORDER = [
  "/",
  "/boards",
  "/follows",
  "/search",
  "/submit",
  "/messages",
  "/notifications",
  "/me",
  "/login",
] as const;

function tabIndex(pathname: string): number {
  return TAB_ORDER.indexOf(pathname as (typeof TAB_ORDER)[number]);
}

/**
 * 方向判定。起点与终点**都是 Tab 根页面**且不同 → 按 Tab 左右顺序：往右切 tab-next（新页自右滑入）、
 * 往左切 tab-prev（新页自左滑入），幅度比层级前进更大（站长反馈：同级切换原先判成 fade，几乎看不到动效）；
 * 否则按层级：目标更深 → push；更浅 → pop；同层或未知 → fade。参数是 pathname（不含查询串）。
 */
export function kindBetween(from: string, to: string): NavKind {
  const fromTab = tabIndex(from);
  const toTab = tabIndex(to);
  if (fromTab >= 0 && toTab >= 0 && fromTab !== toTab)
    return toTab > fromTab ? "tab-next" : "tab-prev";
  const a = rank(from);
  const b = rank(to);
  if (a === null || b === null || a === b) return "fade";
  return b > a ? "push" : "pop";
}

/** 方向属性的保底清除时间：正常由 releaseNavKind 清，这里只防「导航从未提交」导致的残留 */
const SAFETY_CLEAR_MS = 15_000;
let safetyTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 记录本次导航的方向（后一次覆盖前一次）。expand / collapse 另带圆心：写到 <html> 的 --vt-x / --vt-y，
 * 供 clip-path 圆形动画使用（globals.css 的 vt-page-expand / vt-page-collapse）。
 */
export function setNavKind(
  kind: NavKind,
  origin?: NavOrigin | null,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.nav = kind;
  if (origin) {
    root.style.setProperty("--vt-x", `${Math.round(origin.x)}px`);
    root.style.setProperty("--vt-y", `${Math.round(origin.y)}px`);
    if (origin.r !== undefined) root.style.setProperty("--vt-r", `${Math.ceil(origin.r)}px`);
    else root.style.removeProperty("--vt-r");
  } else {
    root.style.removeProperty("--vt-x");
    root.style.removeProperty("--vt-y");
    root.style.removeProperty("--vt-r");
  }
  clearTimeout(safetyTimer);
  safetyTimer = setTimeout(() => clearNavKind(root), SAFETY_CLEAR_MS);
}

/** 立即清除方向与圆心（导航失败 / 被拦下时用，避免残留到下一次导航）。 */
export function clearNavKind(root: HTMLElement = document.documentElement): void {
  clearTimeout(safetyTimer);
  delete root.dataset.nav;
  root.style.removeProperty("--vt-x");
  root.style.removeProperty("--vt-y");
  root.style.removeProperty("--vt-r");
}

/**
 * 页面已提交后释放方向：若有进行中的页面过渡，等它结束再清（动画选择器依赖该属性，
 * 提前清掉会让正在播放的动画失去方向）；没有过渡则立即清。
 */
export function releaseNavKind(root: HTMLElement = document.documentElement): void {
  if (!root.dataset.nav) return;
  const vt = (document as Document & { activeViewTransition?: { finished: Promise<void> } })
    .activeViewTransition;
  if (!vt) {
    clearNavKind(root);
    return;
  }
  const kind = root.dataset.nav;
  void vt.finished
    .catch(() => {})
    .then(() => {
      // 期间若已有新的导航写了别的方向，不能误清
      if (root.dataset.nav === kind) clearNavKind(root);
    });
}

/**
 * 触点扩散 / 收起（M10.7 Step 4c，站长原话「帖子扩散打开、返回收起」）：
 * - **扩散**：从带 `data-vt-expand` 的内容卡片（FeedCard / ThreadRow）点进**主题页**，新页以点击点为圆心展开；
 * - **收起**：随后用站内链接回到**打开它的那个列表页**（同一 pathname + search），详情页以同一位置缩回。
 *
 * 收起的圆心取「点击时卡片在文档中的位置」：站内链接导航到列表页后页面停在顶部（Next 不恢复滚动），
 * 该位置落在第一屏内时，圆缩向那张卡；落在第一屏之外（卡片在页面深处）就找不到焦点，
 * 改缩向可视区域的底部中心（缩向屏幕之外的一片空白没有意义，而退化成 pop 滑动会让「收起」时有时无）。
 * 记录只存内存（整页刷新即失效），一次性消费。
 *
 * **坐标系**：clip-path 的 `circle(... at X Y)` 相对**被命名元素自己的盒子**（template.tsx 里全宽的
 * `[data-fw-page]` 包装 div：左边恒为 0，顶部 = 顶栏等 chrome 的高度）。所以写进 --vt-x / --vt-y 的是
 * 「视口坐标 − 包装盒子左上角」：扩散时新页停在顶部（盒子顶 = pageTop）；收起时旧页（详情）可能滚动过（盒子顶 = pageTop − scrollY）。
 */
interface ExpandRecord {
  /** 打开详情的列表页（pathname + search） */
  fromKey: string;
  /** 被打开的详情页 pathname */
  toPath: string;
  x: number;
  /** 点击点在文档中的纵坐标（clientY + scrollY） */
  docY: number;
}
let lastExpand: ExpandRecord | null = null;

const pathOf = (key: string) => key.split("?")[0]!;

export interface NavStartInfo {
  /** 当前页（pathname + search） */
  from: string;
  /** 目标页（pathname + search） */
  to: string;
  /** 被点击的链接；程序化发起（重试）时为 null */
  anchor: Element | null;
  /** 点击点（视口坐标）；无点击时为 null */
  point: NavOrigin | null;
}

/** 综合层级、点击来源与上一次扩散记录，决定本次导航的方向与圆心 */
export interface NavViewport {
  scrollY: number;
  innerHeight: number;
  /** 视口宽度；算终点半径用，缺省取 innerHeight 的 1.5 倍近似 */
  innerWidth?: number;
  /** 当前页 `[data-fw-page]` 包装盒子的**文档**顶部位置（rect.top + scrollY）；新页的 chrome 相同，取同一值 */
  pageTop: number;
}

/** 圆心（视口坐标）到视口最远一角的距离 + 余量：圆长到这个半径就恰好盖满视口 */
function coverRadius(x: number, viewportY: number, width: number, height: number): number {
  const dx = Math.max(x, width - x);
  const dy = Math.max(viewportY, height - viewportY);
  return Math.hypot(dx, dy) + 8;
}

function currentViewport(): NavViewport {
  if (typeof window === "undefined") return { scrollY: 0, innerHeight: 0, pageTop: 0 };
  const wrapper = document.querySelector("[data-fw-page]");
  return {
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    pageTop: wrapper ? wrapper.getBoundingClientRect().top + window.scrollY : 0,
  };
}

export function resolveNavKind(
  info: NavStartInfo,
  viewport: NavViewport = currentViewport(),
): { kind: NavKind; origin: NavOrigin | null } {
  const base = kindBetween(pathOf(info.from), pathOf(info.to));

  // 只扩散到主题页：卡片里的板块名 / 作者等其它链接是普通前进，不做扩散
  const toThread = /^\/t\/[^/]+/.test(pathOf(info.to));
  if (base === "push" && toThread && info.point && info.anchor?.closest("[data-vt-expand]")) {
    lastExpand = {
      fromKey: info.from,
      toPath: pathOf(info.to),
      x: info.point.x,
      docY: info.point.y + viewport.scrollY,
    };
    // 新页停在顶部：它的盒子顶 = pageTop，触点相对盒子 = 视口 y − pageTop
    const width = viewport.innerWidth ?? viewport.innerHeight * 1.5;
    return {
      kind: "expand",
      origin: {
        x: info.point.x,
        y: info.point.y - viewport.pageTop,
        r: coverRadius(info.point.x, info.point.y, width, viewport.innerHeight),
      },
    };
  }

  if (base === "pop" && lastExpand) {
    const record = lastExpand;
    // 回到的正是打开这张详情的列表页：一次性消费记录。
    // 只比 pathname：返回链接（如顶栏「首页」）不带打开时的筛选 / 翻页查询串（?sec=、?page=），
    // 严格比较会让「从筛选后的首页打开 → 回首页」退化成普通 pop
    if (pathOf(record.fromKey) === pathOf(info.to) && record.toPath === pathOf(info.from)) {
      lastExpand = null;
      const width = viewport.innerWidth ?? viewport.innerHeight * 1.5;
      // 列表页（新页）停在顶部：卡片在第一屏内时缩向它（视口 y = docY）；
      // 在第一屏之外（点击时已滚动很深）就找不到焦点，改缩向可视区域的底部中心，
      // 比退化成普通 pop 更能保持「收起」的一致观感
      const inFirstScreen = record.docY < viewport.innerHeight - 24;
      const x = inFirstScreen ? record.x : width / 2;
      const viewportY = inFirstScreen ? record.docY : viewport.innerHeight;
      // 旧页（详情）的盒子顶 = pageTop − scrollY，圆心相对它的盒子
      return {
        kind: "collapse",
        origin: {
          x,
          y: viewportY - viewport.pageTop + viewport.scrollY,
          r: coverRadius(x, viewportY, width, viewport.innerHeight),
        },
      };
    }
  }
  return { kind: base, origin: null };
}

/** 测试用：清空扩散记录 */
export function resetExpandRecord(): void {
  lastExpand = null;
}
