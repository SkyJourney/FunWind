"use client";

import { useCallback, useState } from "react";

/** 上行进度快照（字节）：total 含 multipart 开销，百分比是近似值 */
export interface UploadProgressValue {
  loaded: number;
  total: number;
}

/**
 * 上传进度状态（M16.1 Step 1）：三个消费方（附件面板 / 头像 / 正文插图）共用同一套状态与呈现，
 * 避免各写一份。用法：开始时 `resetProgress()`，把 `onProgress` 透传给 uploadFile，
 * 结束（成功或失败）再 `resetProgress()`。
 */
export function useUploadProgress() {
  const [progress, setProgress] = useState<UploadProgressValue | null>(null);
  const onProgress = useCallback(
    (loaded: number, total: number) => setProgress({ loaded, total }),
    [],
  );
  const resetProgress = useCallback(() => setProgress(null), []);
  return { progress, onProgress, resetProgress };
}

/**
 * 上传进度条（M16.1 Step 1）：**两态**——
 * - 上行中：真实百分比（XHR upload.onprogress）；
 * - 处理中：上行已到 100%，但服务端还在嗅探类型 / sharp 重编码 / 落盘，这段没有进度可报，
 *   故呈现不定态（满格 + 脉冲），不再显示会误导人的「100%」停滞。
 *
 * 宽度是布局型过渡，按 motion-spec §6 第 6 条必须带 motion-reduce:transition-none；
 * 脉冲用 animate-pulse，reduce 下由 globals.css 兜底归零（M16 Step 4.5）。
 */
export function UploadProgress({
  value,
  label = "上传中",
}: {
  value: UploadProgressValue;
  /** 场景前缀（如文件名）：同时用于可见文案与读屏标签 */
  label?: string;
}) {
  const percent =
    value.total > 0 ? Math.min(100, Math.round((value.loaded / value.total) * 100)) : 0;
  const processing = value.total > 0 && value.loaded >= value.total;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={processing ? undefined : percent}
        aria-label={processing ? `${label}：服务端处理中` : `${label}进度`}
        className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full bg-primary transition-[width] duration-fast ease-out motion-reduce:transition-none ${
            processing ? "w-full animate-pulse" : ""
          }`}
          style={processing ? undefined : { width: `${percent}%` }}
        />
      </div>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {processing ? "处理中…" : `${percent}%`}
      </span>
    </div>
  );
}
