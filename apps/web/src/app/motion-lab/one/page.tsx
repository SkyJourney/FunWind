"use client";

import Link from "next/link";
import { useLayoutEffect } from "react";

/**
 * M15 Step 0-2a 实验页：useLayoutEffect 里延迟声明方向（data-nav="push"）。
 * useLayoutEffect 在 commit 时同步执行（早于浏览器捕获新状态），理论上目标页声明来得及
 * 影响进场动画的方向选择——这正是「方向延迟解析」可行性的关键证据点（对照 two 的 useEffect 版）。
 * 同时在 render 期打 performance.mark，E2E 可对比「页面渲染 vs 过渡启动」的先后（验证 2 时序）。
 */
export default function LabOne() {
  useLayoutEffect(() => {
    document.documentElement.dataset.nav = "push";
  }, []);
  if (typeof window !== "undefined") performance.mark("m15-lab-one-render");
  return (
    <main className="mx-auto max-w-2xl space-y-3 px-4 py-10">
      <h1 className="text-xl font-semibold">Lab One</h1>
      <p className="text-sm text-muted-foreground">
        共享段兄弟页。前往 two 触发段级过渡；本页 useLayoutEffect 声明 push 方向。
      </p>
      <Link className="text-primary underline" href="/motion-lab/two">
        去-two（段级过渡 + 延迟方向验证 2b）
      </Link>
    </main>
  );
}
