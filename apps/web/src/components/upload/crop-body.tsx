"use client";

import ReactCrop, { type PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type Box, toNaturalCrop } from "./crop-math";

/**
 * 裁剪工具本体（M6.4d2）。只在裁剪对话框里通过 next/dynamic 加载，不进首屏。
 * 框选坐标在屏幕上计算；确认时换算为自然像素（见 crop-math.ts）交给外壳。
 * 本文件是第三方交互壳（拖拽与手柄），换算逻辑在 crop-math 中有单测；本文件由 E2E 覆盖。
 */
export default function CropBody({
  src,
  square,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  src: string;
  square: boolean;
  confirmLabel: string;
  onConfirm: (natural: Box) => void;
  onCancel: () => void;
}) {
  const img = useRef<HTMLImageElement>(null);
  const natural = useRef<{ width: number; height: number } | null>(null);
  const [crop, setCrop] = useState<PixelCrop | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const onLoad = () => {
    const el = img.current;
    if (!el) return;
    natural.current = { width: el.naturalWidth, height: el.naturalHeight };
    // 初始选区：头像为中央正方形（显示尺寸的 80%），其余为整张图
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (square) {
      const side = Math.round(Math.min(w, h) * 0.8);
      setCrop({
        unit: "px",
        x: Math.round((w - side) / 2),
        y: Math.round((h - side) / 2),
        width: side,
        height: side,
      });
    } else {
      setCrop({ unit: "px", x: 0, y: 0, width: w, height: h });
    }
  };

  const confirm = () => {
    const el = img.current;
    if (!el || !natural.current || !crop) {
      setError("请先框选需要的区域。");
      return;
    }
    const box = toNaturalCrop(
      { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
      { width: el.clientWidth, height: el.clientHeight },
      natural.current,
      { square },
    );
    if (box === null) {
      setError("裁剪区域太小，请重新框选。");
      return;
    }
    onConfirm(box);
  };

  return (
    <div className="space-y-3">
      <div className="max-h-[60dvh] overflow-auto">
        <ReactCrop
          crop={crop}
          onChange={(pc) => setCrop(pc)}
          aspect={square ? 1 : undefined}
          keepSelection
          ruleOfThirds
        >
          {/* 裁剪预览来自用户自己选择的本地文件（blob:），不经过 next/image */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={img} src={src} alt="待裁剪的图片" onLoad={onLoad} className="max-w-full" />
        </ReactCrop>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} className="min-h-11 sm:min-h-9">
          取消
        </Button>
        <Button type="button" onClick={confirm} className="min-h-11 sm:min-h-9">
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
