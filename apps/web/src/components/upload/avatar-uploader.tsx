"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CropDialog } from "./crop-dialog";
import type { Box } from "./crop-math";
import { UploadError, uploadFile } from "./upload-client";

/**
 * 头像上传（M6.4d3）：选图 → 强制 1:1 裁剪 → 保存。成功后刷新页面，显示新头像。
 * GIF 不能手动裁剪：直接上传，服务端取首帧并居中裁成正方形（见 lib/uploads/process-image.ts）。
 */
export function AvatarUploader({ currentKey, name }: { currentKey: string | null; name: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);

  const upload = async (f: File, crop?: Box) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await uploadFile({ file: f, purpose: "avatar", crop });
      setPreviewKey(r.storageKey);
      setMessage({ kind: "ok", text: "头像已更新。" });
      router.refresh();
    } catch (e) {
      setMessage({
        kind: "error",
        text: e instanceof UploadError || e instanceof Error ? e.message : "上传失败，请稍后重试。",
      });
    } finally {
      setBusy(false);
    }
  };

  const shownKey = previewKey ?? currentKey;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        {shownKey ? (
          // 头像来自站内 /files（能力 URL，尺寸固定），不经 next/image
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/files/${shownKey}`}
            alt={`${name} 的当前头像`}
            width={96}
            height={96}
            className="size-24 rounded-xl border bg-muted object-cover"
          />
        ) : (
          <div className="flex size-24 items-center justify-center rounded-xl border bg-muted text-sm text-muted-foreground">
            无头像
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="min-h-11 sm:min-h-9"
        >
          {busy ? "上传中…" : "选择头像"}
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          aria-label="选择头像图片"
          tabIndex={-1}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            if (f.type === "image/gif") void upload(f);
            else setFile(f);
          }}
        />
      </div>
      {message && (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={
            message.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
          }
        >
          {message.text}
        </p>
      )}
      <CropDialog
        file={file}
        square
        confirmLabel="保存头像"
        onCancel={() => setFile(null)}
        onConfirm={(box) => {
          const f = file;
          setFile(null);
          if (f) void upload(f, box);
        }}
      />
    </div>
  );
}
