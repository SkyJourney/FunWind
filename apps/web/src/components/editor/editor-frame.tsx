"use client";

import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * 编辑器外框（M10.8 Step 9）：所见即所得与源码两种模式共用同一个外观——边框、聚焦环、吸附在站点顶栏下方的头部。
 *
 * 头部 = 左侧 `bar`（所见即所得是格式工具栏，源码是一行提示；窄屏横向滚动、两端有渐隐提示）
 *      + 右侧固定的 `actions`（切换模式、预览，永远可见、不随工具栏滚走）；
 *      `subbar` 是头部下方的第二行（表格工具条等上下文工具条）。
 * 站点顶栏高度：移动端 h-16、桌面 h-14，头部吸附位置与之对应。
 */
export function EditorFrame({
  bar,
  subbar,
  actions,
  children,
}: {
  bar: ReactNode;
  subbar?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <div className="fw-editor rounded-lg border border-input bg-card shadow-1 focus-within:ring-2 focus-within:ring-ring/50">
        <div className="sticky top-16 z-10 rounded-t-lg border-b bg-card/95 backdrop-blur md:top-14">
          <div className="flex items-stretch">
            <div className="min-w-0 flex-1">{bar}</div>
            {actions && (
              <div className="flex shrink-0 items-center gap-0.5 border-l px-1">{actions}</div>
            )}
          </div>
          {subbar}
        </div>
        {children}
      </div>
    </TooltipProvider>
  );
}
