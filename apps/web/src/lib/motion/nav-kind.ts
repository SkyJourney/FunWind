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
export type NavKind = "push" | "pop" | "fade";

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

/** 方向判定：目标层级更深 → push；更浅 → pop；同层或未知 → fade。参数是 pathname（不含查询串）。 */
export function kindBetween(from: string, to: string): NavKind {
  const a = rank(from);
  const b = rank(to);
  if (a === null || b === null || a === b) return "fade";
  return b > a ? "push" : "pop";
}

/** 方向属性的保底清除时间：正常由 releaseNavKind 清，这里只防「导航从未提交」导致的残留 */
const SAFETY_CLEAR_MS = 15_000;
let safetyTimer: ReturnType<typeof setTimeout> | undefined;

/** 记录本次导航的方向（后一次覆盖前一次）。 */
export function setNavKind(kind: NavKind, root: HTMLElement = document.documentElement): void {
  root.dataset.nav = kind;
  clearTimeout(safetyTimer);
  safetyTimer = setTimeout(() => clearNavKind(root), SAFETY_CLEAR_MS);
}

/** 立即清除方向（导航失败 / 被拦下时用，避免残留到下一次导航）。 */
export function clearNavKind(root: HTMLElement = document.documentElement): void {
  clearTimeout(safetyTimer);
  delete root.dataset.nav;
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
