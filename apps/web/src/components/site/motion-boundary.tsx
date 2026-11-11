"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { MotionPage } from "@/lib/motion";
import { hasSharedLayout, siteMotionRegistry } from "./motion-routes";
import { PageMotionBoundary } from "./page-motion-boundary";

/**
 * 根边界（M15 Step 4 全站收敛）：
 * - 非共享路由：pathname-key 接管，组内/跨页切换都经引擎会话进退场（不再只试点 /t、/a）；
 * - 共享 layout 组（admin/settings）：根边界 key/pageKey 恒为 root-shared——enter="none" 避免跨组进入时
 *   与壳内下沉边界双重进场，exit 保留默认 fw-page-out 让跨组退出时旧页正常淡出（嵌套 VT 在模板重挂
 *   卸载子树时不触发退场，Step 4.5 审查实测；根层是模板重挂下唯一可靠的共享侧退场载体）。
 *   组内切换根边界稳定不触发，由壳内 PageMotionBoundary 播 fade；共享壳（侧栏/头部）在 VT 外不重挂。
 */
export function SiteMotionBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (hasSharedLayout(pathname)) {
    return (
      <MotionPage
        motionKey="root-shared"
        pageKey="root-shared"
        preset={siteMotionRegistry.resolve(pathname)?.preset}
        enter="none"
      >
        {children}
      </MotionPage>
    );
  }
  return <PageMotionBoundary>{children}</PageMotionBoundary>;
}
