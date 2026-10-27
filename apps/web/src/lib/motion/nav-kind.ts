export type NavKind = "fade" | "push" | "pop";

/**
 * 路由方向性过渡（M10.5 S5-C 接线）：全局点击捕获层记录「前进 push / 返回 pop」方向，
 * template.tsx 每次路由切换重挂载时消费并播放对应进场动画（纯 CSS 令牌，零依赖）。
 * 退场动画不做（Next App Router 无稳定退场钩子；进场已足够表达方向语汇——S4 §3.2）。
 */
let pending: NavKind = "fade";

/** 顶层级路径 → 方向序（后进 = push）。未列出的路径取中位（fade）。 */
const ORDER = [
  "/",
  "/boards",
  "/f",
  "/t",
  "/submit",
  "/follows",
  "/search",
  "/messages",
  "/notifications",
  "/points",
  "/u",
  "/me",
  "/admin",
];

export function setNavKind(kind: NavKind): void {
  pending = kind;
}

export function consumeNavKind(): NavKind {
  const k = pending;
  pending = "fade";
  return k;
}

function rank(pathname: string): number {
  const idx = ORDER.indexOf(pathname);
  if (idx >= 0) return idx;
  const hit = ORDER.findIndex((p) => p !== "/" && pathname.startsWith(`${p}/`));
  return hit >= 0 ? hit : Math.floor(ORDER.length / 2);
}

/** 方向判定：目标层级更深 → push；更浅 → pop；同层 → fade。 */
export function kindBetween(from: string, to: string): NavKind {
  if (from === to) return "fade";
  const a = rank(from);
  const b = rank(to);
  return b > a ? "push" : b < a ? "pop" : "fade";
}
