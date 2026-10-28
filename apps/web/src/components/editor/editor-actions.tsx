"use client";

import { CodeXml, Eye, Type } from "lucide-react";
import { ToolButton } from "./toolbar";

/**
 * 编辑器头部右侧的操作（M10.8 Step 9）：切换所见即所得 / 源码、预览。
 * 图标按钮 + 即时提示；名称与此前的文字按钮一致（读屏与测试按名称定位）。
 * 往返不等价的旧帖只能停留在源码模式（forceSource），此时切换按钮置灰。
 */
export function EditorActions({
  mode,
  modeLocked,
  onToggleMode,
  previewBusy,
  onPreview,
}: {
  mode: "rich" | "source";
  modeLocked: boolean;
  onToggleMode: () => void;
  previewBusy: boolean;
  onPreview: () => void;
}) {
  return (
    <>
      <ToolButton
        icon={mode === "rich" ? CodeXml : Type}
        label={mode === "rich" ? "切换到源码" : "切换到所见即所得"}
        disabled={modeLocked}
        onClick={onToggleMode}
      />
      <ToolButton
        icon={Eye}
        label={previewBusy ? "预览中…" : "预览（近似，以发布后为准）"}
        disabled={previewBusy}
        onClick={onPreview}
      />
    </>
  );
}
