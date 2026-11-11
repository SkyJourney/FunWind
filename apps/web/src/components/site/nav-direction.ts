/**
 * 引擎自有方向属性（M15 Step 4 退役 html[data-nav]，迁自 nav-kind.ts 的属性时序）：
 * 把「这次导航的方向」写到 <html data-motion-direction>，页面过渡 CSS 据此选动画
 * （globals.css 的 `:root[data-motion-direction="…"]::view-transition-*(.fw-page-*)`）。
 *
 * 为什么用 <html> 上的属性而不是逐个 <Link transitionTypes>：
 *  - 站里有几百处链接，不必逐个加类型；
 *  - 浏览器前进 / 后退（popstate）不带过渡类型，只能靠属性补方向；
 *  - 点击与 popstate 走同一套机制；
 *  - expand / collapse 的方向在点击拦截时由几何定稿，引擎在导航 transition 之外写属性，
 *    不依赖 addTransitionType（它只能在 startTransition 回调内调用）。
 * 方向由注册表单一事实源解析（引擎 commit），本模块只负责属性的写入/释放时序。
 * 属性要撑到页面真正提交（慢网络下导航会挂起数秒），所以不能点击后定时清除：
 * 在「地址变化且当次过渡结束」之后才清（releaseDirection），另有保底超时。
 */
import type { MotionDirection } from "@/lib/motion";
import type { NavOrigin } from "./nav-geometry";

/** 方向属性的保底清除时间：正常由 releaseDirection 清，这里只防「导航从未提交」导致的残留 */
const SAFETY_CLEAR_MS = 15_000;
let safetyTimer: ReturnType<typeof setTimeout> | undefined;
let directionRevision = 0;

/**
 * 记录本次导航的方向（后一次覆盖前一次）。expand / collapse 另带圆心：写到 <html> 的 --vt-x / --vt-y / --vt-r，
 * 供 clip-path 圆形动画使用（globals.css 的 vt-page-expand / vt-page-collapse）。
 */
export function setDirection(
  direction: MotionDirection,
  origin?: NavOrigin | null,
  root: HTMLElement = document.documentElement,
): void {
  directionRevision += 1;
  root.dataset.motionDirection = direction;
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
  safetyTimer = setTimeout(() => clearDirection(root), SAFETY_CLEAR_MS);
}

/** 立即清除方向与圆心（导航失败 / 被拦下时用，避免残留到下一次导航）。 */
export function clearDirection(root: HTMLElement = document.documentElement): void {
  directionRevision += 1;
  clearTimeout(safetyTimer);
  delete root.dataset.motionDirection;
  root.style.removeProperty("--vt-x");
  root.style.removeProperty("--vt-y");
  root.style.removeProperty("--vt-r");
}

/**
 * 页面已提交后释放方向：若有进行中的页面过渡，等它结束再清（动画选择器依赖该属性，
 * 提前清掉会让正在播放的动画失去方向）；没有过渡则立即清。
 */
export function releaseDirection(root: HTMLElement = document.documentElement): void {
  if (!root.dataset.motionDirection) return;
  const vt = (document as Document & { activeViewTransition?: { finished: Promise<void> } })
    .activeViewTransition;
  if (!vt) {
    clearDirection(root);
    return;
  }
  const direction = root.dataset.motionDirection;
  const revision = directionRevision;
  void vt.finished
    .catch(() => {})
    .then(() => {
      // 方向相同也可能是更新的一次导航，须校验写入代次，避免旧收尾清掉新导航状态。
      if (directionRevision === revision && root.dataset.motionDirection === direction)
        clearDirection(root);
    });
}
