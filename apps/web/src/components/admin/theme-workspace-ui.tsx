"use client";

/**
 * 主题工作区共享 UI 片段（M11.1 Step 7）：上传按钮与操作反馈条，
 * 素材库 / LOGO 管理两个面板共用，避免同形态 JSX 重复。
 */
import type { RefObject } from "react";
import { controlLayout } from "@/components/ui/control-layout";

export function ThemeUploadButton({
  pending,
  fileInput,
  label,
  accept,
  onFile,
}: {
  pending: boolean;
  fileInput: RefObject<HTMLInputElement | null>;
  label: string;
  accept: string;
  onFile: (file: File) => void;
}) {
  return (
    <label
      className={`${controlLayout} relative max-w-full cursor-pointer rounded-md border px-2.5 py-1 text-xs focus-within:ring-2 focus-within:ring-ring hover:bg-accent`}
    >
      {pending ? "处理中…" : label}
      <input
        ref={fileInput}
        type="file"
        accept={accept}
        className="sr-only"
        disabled={pending}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
        }}
      />
    </label>
  );
}

export function ThemeFeedback({
  message,
  error,
}: {
  message: string | null;
  error: string | null;
}) {
  return (
    <>
      {message && (
        <p
          role="status"
          className="rounded-lg border border-success/30 bg-success/10 px-3 py-1.5 text-xs text-success"
        >
          {message}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning"
        >
          {error}
        </p>
      )}
    </>
  );
}

/** 装饰素材下拉（图片填充 / 图片遮罩共用） */
export function DecorAssetSelect({
  ariaLabel,
  value,
  decorFiles,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  decorFiles: readonly { file: string; name: string }[];
  onChange: (file: string) => void;
}) {
  return (
    <label className="grid max-w-full min-w-0 gap-1 text-xs">
      素材
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full max-w-full min-w-0 rounded border bg-background px-2 py-1.5"
      >
        <option value="">选择装饰素材</option>
        {decorFiles.map((file) => (
          <option key={file.file} value={file.file}>
            {file.name}
          </option>
        ))}
      </select>
    </label>
  );
}

const BLEND_OPTIONS = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "soft-light",
  "luminosity",
] as const;

/** 混合模式下拉（图片填充 / 图片遮罩共用） */
export function BlendSelect({
  ariaLabel,
  value,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  onChange: (blend: string) => void;
}) {
  return (
    <label className="grid max-w-full min-w-0 gap-1 text-xs">
      混合模式
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full max-w-full min-w-0 rounded border bg-background px-2 py-1.5"
      >
        {BLEND_OPTIONS.map((blend) => (
          <option key={blend} value={blend}>
            {blend}
          </option>
        ))}
      </select>
    </label>
  );
}
