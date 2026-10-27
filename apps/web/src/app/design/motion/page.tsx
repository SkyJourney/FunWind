import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isDevEnv } from "@/lib/dev-only";
import { MotionDemo } from "./motion-demo";

export const metadata: Metadata = { title: "动效演示" };

/**
 * S4 动效演示页（内部工具）：生产环境不可达（与 /design 同口径）。
 * 四级动效可玩示例，规范见 docs/M10.5-S4-VISUAL-MOTION.md。
 */
export default function MotionDemoPage() {
  if (!isDevEnv()) notFound();
  return (
    <main className="mx-auto max-w-5xl space-y-10 px-4 py-10 sm:px-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">动效演示（S4）</h1>
        <p className="text-sm text-muted-foreground">
          四级动效规范的可玩示例：L1 微交互 → L2 页面方向性 → L3 触点扩散 → L4
          进场编排。令牌与纪律见{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            docs/M10.5-S4-VISUAL-MOTION.md
          </code>
          ； 系统开启「减少动态效果」时全部自动降级。{" "}
          <Link href="/design" className="text-primary hover:underline">
            ← 返回设计令牌
          </Link>
        </p>
      </header>
      <MotionDemo />
    </main>
  );
}
