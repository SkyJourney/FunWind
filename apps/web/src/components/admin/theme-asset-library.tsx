"use client";

import { useState } from "react";
import { decorUrl } from "@/lib/theme/decor-url";
import { useThemeRequest } from "@/components/admin/use-theme-request";
import { ThemeFeedback, ThemeUploadButton } from "@/components/admin/theme-workspace-ui";
import type { SurfaceCapabilities } from "@/lib/theme/surface-schema";

/**
 * 主题工作区内嵌素材库（M11.1 Step 7）：decor 素材的上传 / 预览 / 删除 / 选用集中在这里，
 * 不必跳转独立素材页。上传与删除走 /admin/themes/assets 的 JSON 路由（同源 + site.admin），
 * 成功后 router.refresh() 让服务端重取池清单。「用作底纹 / 内容图」直接写入当前区域的草稿。
 */

export interface AssetLibraryItem {
  file: string;
  name: string;
  /** 被哪些主题包引用（含区域），删除保护与徽标共用 */
  usage: { packId: string; packName: string; surfaceIds: string[] }[];
}

const UPLOAD_ERROR_TEXT: Record<string, string> = {
  bad_type: "仅支持 PNG（文件魔数校验）。",
  too_large: "文件超过 4MB，请压缩后重试。",
  oversize: "图片像素超过 3840×2160，请缩放后重试。",
  "in-use": "素材仍被主题包引用，不能移除。",
  forbidden: "没有权限。",
  not_found: "素材不在池中，可能已被移除。",
};

export function ThemeAssetLibrary({
  items,
  activeSurfaceId,
  activeSurfaceLabel,
  canUseAsFill,
  canUseAsContent,
  onUseAsFill,
  onUseAsContent,
}: {
  items: readonly AssetLibraryItem[];
  activeSurfaceId: string;
  activeSurfaceLabel: string;
  canUseAsFill: boolean;
  canUseAsContent: boolean;
  onUseAsFill: (file: string) => void;
  onUseAsContent: (file: string) => void;
}) {
  const request = useThemeRequest(
    "/admin/themes/assets",
    UPLOAD_ERROR_TEXT,
    "素材操作失败，请重试。",
  );
  const [pending, setPending] = useState(false);
  const [inUse, setInUse] = useState<string | null>(null);

  async function upload(file: File) {
    setPending(true);
    setInUse(null);
    try {
      const body = new FormData();
      body.set("file", file);
      await request.send({ method: "POST", body }, "素材已入池，可直接选用。");
    } finally {
      setPending(false);
    }
  }

  async function remove(file: string) {
    setPending(true);
    setInUse(null);
    try {
      const result = await request.send(
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file }),
        },
        "素材已移出池。",
      );
      if (!result.ok) {
        const usage = (result.payload as { usage?: AssetLibraryItem["usage"] } | undefined)?.usage;
        if (usage?.length) {
          setInUse(
            `素材仍被引用，不能移除：${usage
              .map((ref) => `${ref.packName}（${ref.surfaceIds.join("、")}）`)
              .join("、")}`,
          );
        }
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-label="主题素材库"
      data-testid="theme-asset-library"
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">主题素材库</h3>
        <ThemeUploadButton
          pending={pending}
          fileInput={request.fileInput}
          label="上传 PNG 素材"
          accept="image/png"
          onFile={(file) => void upload(file)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        底纹/装饰图集中管理：PNG ≤4MB、≤3840×2160；上传后可在背景填充或内容插槽中选用。
      </p>
      <ThemeFeedback message={request.message} error={inUse ?? request.error} />
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
          素材库还是空的——上传第一张底纹，让主题拥有图片质感。
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const usageLabel = item.usage
              .map((ref) => `${ref.packName}（${ref.surfaceIds.join("、")}）`)
              .join("、");
            return (
              <li key={item.file} className="space-y-2 rounded-lg border p-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- 素材池公开路由缩略图 */}
                <img
                  src={decorUrl(item.file)}
                  alt={item.name}
                  className="h-20 w-full rounded border object-cover"
                  loading="lazy"
                />
                <p className="truncate text-xs font-medium" title={item.name}>
                  {item.name}
                </p>
                {item.usage.length > 0 && (
                  <p className="truncate text-[11px] text-muted-foreground" title={usageLabel}>
                    被 {item.usage.length} 个主题引用：{usageLabel}
                  </p>
                )}
                <div className="flex flex-wrap gap-1">
                  {canUseAsFill && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onUseAsFill(item.file)}
                      className="rounded border px-2 py-0.5 text-[11px] hover:bg-accent"
                    >
                      用作{activeSurfaceLabel}底纹
                    </button>
                  )}
                  {canUseAsContent && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onUseAsContent(item.file)}
                      className="rounded border px-2 py-0.5 text-[11px] hover:bg-accent"
                    >
                      用作内容图
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void remove(item.file)}
                    className="ml-auto rounded border px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                  >
                    移除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground" data-testid="asset-library-surface-hint">
        当前区域：{activeSurfaceLabel}（{activeSurfaceId}）
      </p>
    </section>
  );
}

/** 判断当前区域能否应用为图片底纹（存在 fill 能力即允许切换为 image 类型） */
export function canApplyAsFill(caps: readonly string[] | undefined): boolean {
  return caps?.includes("fill") ?? false;
}

/** 判断当前区域是否有内容插槽图片位 */
export function canApplyAsContent(caps: readonly string[] | undefined): boolean {
  return caps?.includes("contentSlot") ?? false;
}

export type AssetApplyCapability = Pick<SurfaceCapabilities, "fill" | "contentSlot">;
