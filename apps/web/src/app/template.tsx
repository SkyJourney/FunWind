import type { ReactNode } from "react";
import { SiteMotionBoundary } from "@/components/site/motion-boundary";

/**
 * 根模板只保留一个全宽快照边界，chrome 留在 layout 外层。
 * Next 只在第一段变化时重挂根模板；试点 /t 与 /a 由宿主给 VT 本体设置 pathname key，
 * 共享段导航形成进退场，其余页面仍按根模板重挂兜底。query 不入 key，不能重播页面动画。
 */
export default function Template({ children }: { children: ReactNode }) {
  return <SiteMotionBoundary>{children}</SiteMotionBoundary>;
}
