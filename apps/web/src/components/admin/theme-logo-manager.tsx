"use client";

import { useState } from "react";
import { useThemeRequest } from "@/components/admin/use-theme-request";
import { ThemeFeedback, ThemeUploadButton } from "@/components/admin/theme-workspace-ui";

/**
 * 主题自带 LOGO 管理（M11.1 Step 7）：在工作区内上传 / 换绑 / 解绑该包的 LOGO。
 * 走 /admin/themes/logo-asset 的 JSON 路由（同源 + site.admin）；站点默认联动由
 * setSiteDefaultThemePack 读 assets kind=logo，无需在此重复。
 */

const UPLOAD_ERROR_TEXT: Record<string, string> = {
  bad_type: "仅支持 PNG（文件魔数校验）。",
  too_large: "文件超过 512KB，请压缩后重试。",
  forbidden: "没有权限。",
  not_found: "主题包或素材不存在。",
  "missing-assets": "所选文件不在 LOGO 池中。",
};

export function ThemeLogoManager({
  packId,
  initialLogo,
  poolItems,
  canManage,
}: {
  packId: string;
  /** 当前绑定的池文件；null = 未设置 */
  initialLogo: string | null;
  poolItems: readonly { file: string; name: string; pack?: string }[];
  /** LOGO 池是否已有内容（决定是否显示换绑下拉） */
  canManage: boolean;
}) {
  const request = useThemeRequest(
    "/admin/themes/logo-asset",
    UPLOAD_ERROR_TEXT,
    "LOGO 操作失败，请重试。",
  );
  const [logo, setLogo] = useState<string | null>(initialLogo);
  const [pending, setPending] = useState(false);

  async function send(init: RequestInit, okText: string) {
    setPending(true);
    try {
      const result = await request.send(init, okText);
      if (result.ok) {
        const payload = result.payload as { file: string | null };
        setLogo(payload.file);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-label="主题自带 LOGO"
      data-testid="theme-logo-manager"
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">主题自带 LOGO</h3>
        <span className="text-[11px] text-muted-foreground">
          设为全站默认时自动设为当前 LOGO；之后仍可在「LOGO 管理」独立切换
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden
          className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg border bg-background"
        >
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- LOGO 池公开路由缩略图
            <img
              src={`/brand/logo?file=${encodeURIComponent(logo)}`}
              alt=""
              className="size-full object-contain"
            />
          ) : (
            <span className="text-[10px] text-muted-foreground">未设置</span>
          )}
        </span>
        <ThemeUploadButton
          pending={pending}
          fileInput={request.fileInput}
          label="上传 LOGO（PNG ≤512KB）"
          accept="image/png"
          onFile={(file) => {
            const body = new FormData();
            body.set("packId", packId);
            body.set("file", file);
            void send({ method: "POST", body }, "LOGO 已上传并绑定为本主题自带。");
          }}
        />
        {canManage && (
          <label className="flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">从池中选择</span>
            <select
              value={logo ?? ""}
              disabled={pending}
              onChange={(event) => {
                const file = event.target.value;
                if (!file) return;
                void send(
                  {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ packId, file }),
                  },
                  "LOGO 已换绑。",
                );
              }}
              className="rounded border bg-background px-2 py-1"
            >
              <option value="">（选择池内 LOGO）</option>
              {poolItems.map((item) => (
                <option key={item.file} value={item.file}>
                  {item.name}
                  {item.pack === packId ? "（本主题自带）" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {logo && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void send(
                {
                  method: "DELETE",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ packId }),
                },
                "已解绑本主题的 LOGO。",
              )
            }
            className="rounded-md border px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            解绑
          </button>
        )}
      </div>
      {logo && <p className="truncate text-[11px] text-muted-foreground">当前绑定：{logo}</p>}
      <ThemeFeedback message={request.message} error={request.error} />
      <p className="text-[11px] text-muted-foreground">
        LOGO 与主题是「补充关系」：绑定后随设默认联动，不随普通用户切主题变化。
      </p>
    </section>
  );
}
