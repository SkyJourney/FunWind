/**
 * View Transitions 助手（S4 → M15 Step 3 已收编进引擎）：
 * 本文件现为引擎公开入口的薄兼容 facade——实现（reduce / 无 API 降级、data-vt 选型、
 * 扩散圆心写入/清理、并发守卫）全部在 lib/motion/engine/native.ts，经 barrel 导出。
 * 保留旧签名与 captureTransitionOrigin 的一次性指针捕获便利，供旧消费者与单测使用；
 * 新代码请直接用 `@/lib/motion` 的 playStateTransition。facade 随 Step 4 旧链清账一并移除。
 * 类型语义：fade=默认淡入；expand=触点扩散（push/pop 状态级选型为演示遗留，已随死代码清理）。
 */
import { playStateTransition, type StateTransitionKind } from "./index";

export { prefersReducedMotion } from "./index";

export type VtKind = StateTransitionKind;

let pendingOrigin: { x: number; y: number } | null = null;

export function captureTransitionOrigin(x: number, y: number): void {
  pendingOrigin = { x, y };
}

export async function withViewTransition(
  update: () => void | Promise<void>,
  kind: VtKind = "fade",
  origin?: { x: number; y: number } | null,
): Promise<void> {
  const o = origin ?? pendingOrigin;
  pendingOrigin = null;
  await playStateTransition(update, { kind, origin: o });
}
