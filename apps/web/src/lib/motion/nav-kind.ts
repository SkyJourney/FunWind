export type NavKind = "fade" | "push" | "pop";

/**
 * 路由方向性过渡（M10.5 S5-C 接线）：全局点击捕获层记录「前进 push / 返回 pop」方向，
 * template.tsx 每次路由切换重挂载时消费并播放对应进场动画（纯 CSS 令牌，零依赖）。
 * 退场动画不做（Next App Router 无稳定退场钩子；进场已足够表达方向语汇——S4 §3.2）。
 */
let pending: { kind: NavKind; target: string; time: number } | null = null;

/** 顶层栏目同级；版块和内容详情属于更深层级。 */
function rank(pathname: string): number | null {
  if (pathname === "/") return 0;
  if (/^\/(f|t|u)\/[^/]+/.test(pathname)) return 2;
  if (
    /^\/(boards|follows|search|messages|notifications|points|me|admin|submit)(\/|$)/.test(pathname)
  ) {
    return pathname.split("/").filter(Boolean).length > 1 ? 2 : 1;
  }
  return null;
}

export function setNavKind(kind: NavKind, target = ""): void {
  pending = { kind, target, time: Date.now() };
}

export function consumeNavKind(pathname = ""): NavKind {
  const value = pending;
  pending = null;
  return value && (!value.target || value.target === pathname) && Date.now() - value.time < 5000
    ? value.kind
    : "fade";
}

/** 方向判定：目标层级更深 → push；更浅 → pop；同层或未知 → fade。 */
export function kindBetween(from: string, to: string): NavKind {
  const a = rank(from);
  const b = rank(to);
  if (a === null || b === null || a === b) return "fade";
  return b > a ? "push" : "pop";
}
