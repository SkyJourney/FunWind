/**
 * View Transitions 助手（S4，docs/M10.5-S4-VISUAL-MOTION.md §3）：
 * - withViewTransition(update, kind)：包住一次「状态/路由更新」，浏览器支持时播放对应过渡；
 *   不支持或用户偏好减少动效时直接执行 update——优雅降级，绝不阻塞操作。
 * - captureTransitionOrigin(x, y)：触发处先记录指针位置，作为 expand 的扩散圆心
 *   （写入 --vt-x/--vt-y 供 globals.css 的 vt-expand 关键帧消费）。
 * 类型语义：fade=默认淡入；push=前进（自右切入）；pop=返回（自左切入）；expand=触点扩散。
 * 路由级过渡在 S5 接线（导航前调用本助手包裹 router.push）；React <ViewTransition> 待 Next
 * 稳定暴露后再评估迁移。
 */

export type VtKind = "fade" | "push" | "pop" | "expand";

let pendingOrigin: { x: number; y: number } | null = null;
let activeTransition = 0;

export function captureTransitionOrigin(x: number, y: number): void {
  pendingOrigin = { x, y };
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type DocumentWithVT = Document & {
  startViewTransition?: (cb: () => Promise<void> | void) => { finished: Promise<void> };
};

export async function withViewTransition(
  update: () => void | Promise<void>,
  kind: VtKind = "fade",
  origin?: { x: number; y: number } | null,
): Promise<void> {
  const doc = document as DocumentWithVT;
  const o = origin ?? pendingOrigin;
  pendingOrigin = null;
  if (!doc.startViewTransition || prefersReducedMotion()) {
    await update();
    return;
  }
  const transition = ++activeTransition;
  const root = doc.documentElement;
  root.style.removeProperty("--vt-x");
  root.style.removeProperty("--vt-y");
  if (kind === "expand" && o) {
    root.style.setProperty("--vt-x", `${o.x}px`);
    root.style.setProperty("--vt-y", `${o.y}px`);
  }
  root.dataset.vt = kind;
  try {
    const vt = doc.startViewTransition(() => Promise.resolve(update()));
    await vt.finished.catch(() => {});
  } finally {
    if (transition === activeTransition) {
      delete root.dataset.vt;
      root.style.removeProperty("--vt-x");
      root.style.removeProperty("--vt-y");
    }
  }
}
