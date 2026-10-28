"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";

/**
 * 插入图片的按钮（M6.4d2）：选择文件后交给外壳（外壳决定是否先裁剪、再上传、再插入）。
 * 「裁剪后插入」默认关闭：直接插入是最常见的操作，裁剪是可选的。
 */
export function ImagePicker({
  disabled,
  onPick,
  openRef,
}: {
  disabled?: boolean;
  onPick: (file: File, wantCrop: boolean) => void;
  /** 交出「打开文件选择」的能力：工具栏的图片按钮与本组件共用同一个文件框（同一套裁剪选项） */
  openRef?: RefObject<(() => void) | null>;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!openRef) return;
    openRef.current = () => input.current?.click();
    return () => {
      openRef.current = null;
    };
  }, [openRef]);
  const [wantCrop, setWantCrop] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="min-h-11 sm:min-h-9"
      >
        插入图片
      </Button>
      <label className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground sm:min-h-9">
        <input
          type="checkbox"
          checked={wantCrop}
          onChange={(e) => setWantCrop(e.target.checked)}
          className="size-4"
        />
        裁剪后插入
      </label>
      <input
        ref={input}
        type="file"
        accept="image/*"
        aria-label="选择图片"
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // 清空选择，同一文件可以再次选择
          e.target.value = "";
          if (file) onPick(file, wantCrop);
        }}
      />
    </div>
  );
}

/** 剪贴板里的第一张图片（粘贴截图）；没有图片返回 null，文本粘贴不受影响 */
export function imageFileFromClipboard(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}
