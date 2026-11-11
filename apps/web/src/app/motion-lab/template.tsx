import type { ReactNode } from "react";
import { ViewTransition } from "react";

/**
 * M15 Step 0-1 实验用段级模板（/motion-lab 共享段）：
 * /lab/one → /lab/two 等兄弟页切换时，根 template（app/template.tsx）不重挂（/design/motion 段未变），
 * 本 template 重挂 → 它的 <ViewTransition> children 变化 → 应只产生段级一次过渡（F2 官方路径验证）。
 * 类名 .fw-lab-in/.fw-lab-out 与根 template 的 .fw-page-in/.fw-page-out 区分，E2E 的 rAF 采样
 * 才能区分「哪一层触发了过渡」。实验代码，Step 4 清账时随 lab 一起移除。
 */
export default function LabTemplate({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter="fw-lab-in" exit="fw-lab-out">
      <div data-fw-lab>{children}</div>
    </ViewTransition>
  );
}
