"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * M15 Step 0-2b 实验页（对照 2a）：useEffect 版延迟声明方向（写 push——lab CSS 的有效分支）。
 * useEffect 在 paint 后执行——若声明来得及，新层动画会选 in-right；来不及则保持默认 fade-in。
 * 2a（useLayoutEffect，commit 同步）与 2b 的采样对比 = 「方向延迟解析」的时点结论。
 */
export default function LabTwo() {
  useEffect(() => {
    document.documentElement.dataset.nav = "push";
  }, []);
  if (typeof window !== "undefined") performance.mark("m15-lab-two-render");
  return (
    <main className="mx-auto max-w-2xl space-y-3 px-4 py-10">
      <h1 className="text-xl font-semibold">Lab Two</h1>
      <p className="text-sm text-muted-foreground">
        共享段兄弟页。前往 one 触发段级过渡；本页 useEffect 声明 pop 方向（预期来不及生效）。
      </p>
      <Link className="text-primary underline" href="/design/motion/lab/one">
        去-one（段级过渡 + 延迟方向验证 2a）
      </Link>
      <Link className="text-primary underline" href="/design/motion/lab/back">
        去返回键实验页（验证 3）
      </Link>
    </main>
  );
}
