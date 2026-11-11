import type { ReactNode } from "react";
import { SiteMotionBoundary } from "@/components/site/motion-boundary";

/**
 * 根模板只保留一个全宽快照边界，chrome 留在 layout 外层。
 * M15 Step 4 全站收敛：所有路由（除同 pathname 查询串变化）都建引擎会话；非共享路由由
 * 宿主给 VT 本体设 pathname key 形成进退场，共享 layout 组（admin/settings）根边界恒定且
 * enter/exit=none，动画与生命周期交壳内下沉的 PageMotionBoundary。query 不入 key，不能重播页面动画。
 */
export default function Template({ children }: { children: ReactNode }) {
  return <SiteMotionBoundary>{children}</SiteMotionBoundary>;
}
