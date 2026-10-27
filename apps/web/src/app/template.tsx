"use client";

import type { ReactNode } from "react";
import { consumeNavKind } from "@/lib/motion/nav-kind";

/**
 * 路由切换进场动画（S5-C 接线）：template 在每次导航时重挂载，
 * 消费 NavKindCapture 记录的方向播放 push/pop 进场（CSS 令牌；首次加载与同级导航不播）。
 * 退场不处理——Next App Router 无稳定退场钩子，进场已表达方向语汇（S4 §3.2）。
 */
export default function Template({ children }: { children: ReactNode }) {
  const kind = consumeNavKind();
  const anim =
    kind === "push"
      ? "vt-push-in var(--fw-dur-slow) var(--fw-ease-out) both"
      : kind === "pop"
        ? "vt-pop-in var(--fw-dur-slow) var(--fw-ease-out) both"
        : undefined;
  return (
    <div style={anim ? { animation: anim } : undefined} className="min-h-0">
      {children}
    </div>
  );
}
