"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { MotionPage } from "@/lib/motion";
import { siteMotionRegistry } from "./motion-routes";

/**
 * 页面层 keyed VT 边界（M15 Step 4 全站收敛）：按 pathname 换 key 形成进退场。
 * 共享 layout 组（admin/settings）把本边界下沉到壳内包裹页面 children——组内切换有过渡，
 * 而共享壳（侧栏/头部/抽屉）在边界外保持挂载、不重挂；pageKey=pathname 认领引擎会话，
 * 外层根边界对共享路由用 root-shared（不认领、不播动画），每会话恰一个边界认领。
 */
export function PageMotionBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <MotionPage
      motionKey={`page:${pathname}`}
      pageKey={pathname}
      preset={siteMotionRegistry.resolve(pathname)?.preset}
    >
      {children}
    </MotionPage>
  );
}
