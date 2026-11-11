/**
 * 触点扩散 / 收起几何（M15 Step 4 自 nav-kind.ts 迁入，方向判定归注册表）：
 * - **扩散**：从带 `data-vt-expand` 的内容卡片（FeedCard / ThreadRow）点进**主题页**，新页以点击点为圆心展开；
 * - **收起**：随后用站内链接回到**打开它的那个列表页**（同一 pathname），详情页以同一位置缩回。
 *
 * base 方向不再查 rank 表，改由注册表 `siteMotionDirection` 给出（与旧 kindBetween 全矩阵一致，
 * 一致性测试退役前已验证）；本模块只负责「扩散/收起的圆心与半径」几何，不写任何 DOM 属性。
 *
 * 收起的圆心取「点击时卡片在文档中的位置」：站内链接导航到列表页后页面停在顶部（Next 不恢复滚动），
 * 该位置落在第一屏内时圆缩向那张卡；落在第一屏之外（卡片在页面深处）就找不到焦点，
 * 改缩向可视区域的底部中心。记录只存内存（整页刷新即失效），一次性消费。
 *
 * **坐标系**：clip-path 的 `circle(... at X Y)` 相对**被命名元素自己的盒子**（全宽 `[data-fw-page]`
 * 包装 div：左边恒为 0，顶部 = 顶栏等 chrome 的高度）。所以写进 --vt-x / --vt-y 的是
 * 「视口坐标 − 包装盒子左上角」：扩散时新页停在顶部（盒子顶 = pageTop）；收起时旧页（详情）可能滚动过（盒子顶 = pageTop − scrollY）。
 */
import type { MotionDirection } from "@/lib/motion";
import { siteMotionDirection } from "./motion-routes";

/** 扩散 / 收起的圆：圆心（相对 [data-fw-page] 包装盒子，px）与终点半径（px，覆盖视口所需的最小值）。 */
export interface NavOrigin {
  x: number;
  y: number;
  /** 终点半径；缺省时 CSS 回退到 150vmax */
  r?: number;
}

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

export interface NavViewport {
  scrollY: number;
  innerHeight: number;
  /** 视口宽度；算终点半径用，缺省取 innerHeight 的 1.5 倍近似 */
  innerWidth?: number;
  /** 当前页 `[data-fw-page]` 包装盒子的**文档**顶部位置（rect.top + scrollY）；新页的 chrome 相同，取同一值 */
  pageTop: number;
}

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

/** 综合注册表方向、点击来源与上一次扩散记录，决定本次导航的方向与圆心 */
export function resolveNavGeometry(
  info: NavStartInfo,
  viewport: NavViewport = currentViewport(),
): { kind: MotionDirection; origin: NavOrigin | null } {
  const base = siteMotionDirection(pathOf(info.from), pathOf(info.to));

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
