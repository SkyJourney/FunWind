"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * 运维页自动刷新（M14 Step 3，F21 全站首个轮询组件）：台账里有执行中的记录时每 5 秒
 * router.refresh()（RSC 重取，不动客户端状态），没有就清掉定时器——状态收尾后自动停止。
 * server-only 依赖不能进客户端闭包，running 与否由服务端页面算好传下来。
 */
export function OpsAutoRefresh({ running }: { running: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), 5_000);
    return () => clearInterval(timer);
  }, [running, router]);

  if (!running) return null;
  return (
    <p className="mt-3 text-xs text-muted-foreground" data-testid="ops-auto-refresh">
      有任务执行中——每 5 秒自动刷新，结束后自动停止。
    </p>
  );
}
