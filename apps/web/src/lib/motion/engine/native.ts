/**
 * 同文档状态级 View Transition 驱动（M15 Step 3 收编手动助手，docs/motion-spec.md §6.2）。
 *
 * 浏览器适配层：document / window 只在函数体内访问，模块顶层无浏览器依赖，SSR 安全。
 * 引擎核心仍是纯逻辑；本模块为「非路由」的状态切换（如演示页卡片扩散打开）提供原生驱动，
 * 与路由级过渡（html[data-nav]）互不干扰。reduce / 无 API 时直接执行 update，绝不阻塞操作。
 * 类型语义：fade=默认淡入；expand=触点扩散（圆心写入 --vt-x/--vt-y 供 vt-expand 关键帧消费）。
 */

export type StateTransitionKind = "fade" | "expand";

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type DocumentWithVT = Document & {
  startViewTransition?: (cb: () => Promise<void> | void) => { finished: Promise<void> };
};

export function supportsViewTransition(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof (document as DocumentWithVT).startViewTransition === "function"
  );
}

/** 并发守卫：较早的过渡结束不得清除较新过渡写入的 data-vt / 圆心 */
let activeTransition = 0;

export interface StateTransitionOptions {
  readonly kind?: StateTransitionKind;
  readonly origin?: { x: number; y: number } | null;
  /** 显式指定 reduce 偏好（测试用）；缺省实时读取 matchMedia */
  readonly reducedMotion?: boolean;
}

export async function playStateTransition(
  update: () => void | Promise<void>,
  options: StateTransitionOptions = {},
): Promise<void> {
  const kind = options.kind ?? "fade";
  const reduced = options.reducedMotion ?? prefersReducedMotion();
  const doc = typeof document !== "undefined" ? (document as DocumentWithVT) : undefined;
  if (!doc?.startViewTransition || reduced) {
    await update();
    return;
  }
  const transition = ++activeTransition;
  const root = doc.documentElement;
  root.style.removeProperty("--vt-x");
  root.style.removeProperty("--vt-y");
  if (kind === "expand" && options.origin) {
    root.style.setProperty("--vt-x", `${options.origin.x}px`);
    root.style.setProperty("--vt-y", `${options.origin.y}px`);
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
