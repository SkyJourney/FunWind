"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * M15 Step 0-3 实验页：记录 popstate / pagehideshow 时刻，E2E 从本页 page.goBack() 后
 * 读取 vt 打桩（__vtStarts 是否新增、动画是否被跳过）与本页时间线，判定「返回键能否带出过渡」。
 */
export default function LabBack() {
  useEffect(() => {
    const onPop = () => performance.mark("m15-lab-popstate");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return (
    <main className="mx-auto max-w-2xl space-y-3 px-4 py-10">
      <h1 className="text-xl font-semibold">Lab Back</h1>
      <p className="text-sm text-muted-foreground">
        从 two 点进本页后执行浏览器返回（E2E goBack），观察是否产生过渡（React 文档预期：popstate
        启动的过渡动画被跳过）。
      </p>
      <Link className="text-primary underline" href="/design/motion/lab/two">
        去-two
      </Link>
    </main>
  );
}
