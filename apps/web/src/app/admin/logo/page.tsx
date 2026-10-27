import { CheckCircle2, Trash2, Upload } from "lucide-react";
import { requireAdmin } from "@/lib/authz/require-admin";
import { getLogoPoolRaw } from "@/lib/brand/logo-pool";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { removeLogoAction, setActiveLogoAction, uploadLogoAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "LOGO 管理" };

const ERR_TEXT: Record<string, string> = {
  forbidden: "没有权限。",
  bad_type: "仅支持 PNG（文件魔数校验）。",
  too_large: "文件超过 512KB——请先用 scripts/logo-resize.py 入池预处理。",
};

/**
 * LOGO 管理（M10.5，docs/LOGO-POOL.md）：池网格 + 上传 + 设为当前/移除。
 * 门禁 site.admin（站点级配置语义，复用总开关权限点，不新增词汇表）。
 */
export default async function LogoAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; "confirm-remove"?: string }>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  const pool = await getLogoPoolRaw();
  const sp = await searchParams;
  // 无 JS 回退（M10.6d）：?confirm-remove=<file> 渲染原生表单确认段（有 JS 时 ConfirmSubmit 对话框接管）
  const confirmRemove =
    sp["confirm-remove"] && pool.items.some((i) => i.file === sp["confirm-remove"])
      ? pool.items.find((i) => i.file === sp["confirm-remove"])!
      : null;

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-bold tracking-tight">LOGO 管理</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          品牌池随时切换（节日 / 联动主题日）；当前项经{" "}
          <code className="rounded bg-muted px-1 text-xs">/brand/logo</code> 全站输出，切换最多 5
          分钟收敛。PNG ≤512KB（入池前用 scripts/logo-resize.py 预处理出 112/224 双档更佳）。
        </p>
      </header>

      {sp.err && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {ERR_TEXT[sp.err] ?? "操作失败，请重试。"}
        </p>
      )}

      {confirmRemove && (
        <div
          role="alertdialog"
          aria-label="确认移除"
          className="rounded-xl border border-warning/40 bg-warning/10 p-4"
        >
          <p className="text-sm font-medium">无脚本模式 · 确认移除「{confirmRemove.name}」？</p>
          <p className="mt-1 text-xs text-warning">
            将把该 LOGO 移出池并取消登记；不影响当前生效项展示，文件保留在服务器磁盘。
          </p>
          <form action={removeLogoAction} className="mt-3 flex gap-2">
            <input type="hidden" name="file" value={confirmRemove.file} />
            <SubmitButton className="rounded-lg bg-destructive px-4 py-1.5 text-sm font-medium text-white hover:bg-destructive/90 disabled:opacity-60">
              确认移除
            </SubmitButton>
          </form>
        </div>
      )}

      {/* 上传 */}
      <Card>
        <CardContent className="pt-5">
          <form action={uploadLogoAction} className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              名称
              <input
                name="name"
                maxLength={40}
                placeholder="如：圣诞节版"
                className="w-48 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="grid flex-1 gap-1 text-sm">
              PNG 文件（≤512KB）
              <input
                type="file"
                name="file"
                accept="image/png"
                required
                className="rounded-lg border bg-background px-3 py-1.5 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm"
              />
            </label>
            <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              <Upload className="mr-1 inline size-4" aria-hidden /> 上传入池
            </SubmitButton>
          </form>
        </CardContent>
      </Card>

      {/* 池网格 */}
      {pool.items.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card/50 px-6 py-10 text-center text-sm text-muted-foreground">
          池还是空的——上传第一枚 LOGO；为空时前台显示占位图标。
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pool.items.map((item) => {
            const active = pool.active === item.file;
            return (
              <Card key={item.file} className={active ? "border-primary/60" : undefined}>
                <CardContent className="flex items-center gap-3 pt-5">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 管理页缩略图走公开品牌路由（当前项）或 /files（池内历史项为管理员可见） */}
                  <img
                    src={
                      active ? "/brand/logo" : `/brand/logo?file=${encodeURIComponent(item.file)}`
                    }
                    alt={item.name}
                    width={56}
                    height={56}
                    className="size-14 rounded-lg border object-contain"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    {active && (
                      <p className="mt-0.5 flex items-center gap-0.5 text-xs text-primary">
                        <CheckCircle2 className="size-3.5 shrink-0" aria-hidden /> 当前生效中
                      </p>
                    )}
                    <p className="truncate text-xs text-muted-foreground">{item.file}</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1.5">
                    {!active && (
                      <form action={setActiveLogoAction}>
                        <input type="hidden" name="file" value={item.file} />
                        <SubmitButton className="w-full rounded-md border px-2.5 py-1 text-xs hover:bg-accent">
                          设为当前
                        </SubmitButton>
                      </form>
                    )}
                    <form action={removeLogoAction}>
                      <input type="hidden" name="file" value={item.file} />
                      <ConfirmSubmit
                        title="移除这枚 LOGO？"
                        description="将该 LOGO 移出池并取消登记；不影响当前生效的 LOGO 展示，文件保留在服务器磁盘，可重新上传入池。"
                        className="w-full rounded-md border px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10"
                        pendingText="处理中…"
                      >
                        <Trash2 className="inline size-3" aria-hidden /> 移除
                      </ConfirmSubmit>
                      <noscript>
                        <a
                          href={`?confirm-remove=${encodeURIComponent(item.file)}`}
                          className="mt-1 block text-center text-xs text-warning underline"
                        >
                          无脚本模式移除
                        </a>
                      </noscript>
                    </form>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
