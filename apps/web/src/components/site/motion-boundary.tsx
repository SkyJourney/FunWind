"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { MotionPage } from "@/lib/motion";
import { hasSharedLayout, siteMotionRegistry } from "./motion-routes";
import { PageMotionBoundary } from "./page-motion-boundary";

/**
 * 根边界（M15 Step 4 全站收敛）：
 * - 非共享路由：pathname-key 接管，组内/跨页切换都经引擎会话进退场（不再只试点 /t、/a）；
 * - 共享 layout 组（admin/settings）：根边界 key/pageKey 恒为 root-shared 且 enter/exit=none，
 *   不重挂共享壳、不播动画、不认领会话——动画与生命周期交给壳内下沉的 PageMotionBoundary。
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
        exit="none"
      >
        {children}
      </MotionPage>
    );
  }
  return <PageMotionBoundary>{children}</PageMotionBoundary>;
}
