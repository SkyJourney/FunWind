"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Box } from "./crop-math";

/** 裁剪工具按需加载：react-image-crop 与其样式只在用户选择「裁剪」时下载 */
const CropBody = dynamic(() => import("./crop-body"), {
  ssr: false,
  loading: () => <p className="text-sm text-muted-foreground">正在加载裁剪工具…</p>,
});

/**
 * 裁剪对话框（M6.4d2）。file 为 null 时关闭。确认后交出自然像素的裁剪框，由调用方决定上传用途。
 * 本地预览用 blob URL，关闭或换文件时释放。
 */
export function CropDialog({
  file,
  square,
  confirmLabel = "插入图片",
  onConfirm,
  onCancel,
}: {
  file: File | null;
  square: boolean;
  confirmLabel?: string;
  onConfirm: (natural: Box) => void;
  onCancel: () => void;
}) {
  const src = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>裁剪图片</DialogTitle>
          <DialogDescription>
            {square ? "头像需为正方形，拖动框选需要的区域。" : "拖动框选需要保留的区域。"}
          </DialogDescription>
        </DialogHeader>
        {src && (
          <CropBody
            src={src}
            square={square}
            confirmLabel={confirmLabel}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
