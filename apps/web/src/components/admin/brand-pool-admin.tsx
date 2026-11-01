import type { ReactNode } from "react";
import { CheckCircle2, Trash2, Upload } from "lucide-react";
import type { BrandItem, BrandPool } from "@/lib/brand/brand-pool";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { BrandFileInput } from "@/components/admin/brand-file-input";
import { AdminFlash } from "@/components/admin/admin-flash";

type FormAction = (formData: FormData) => Promise<void>;

/** 管理页 searchParams 形状（logo / hero 共用） */
export interface BrandPoolSearchParams {
  err?: string;
  added?: string;
  "confirm-remove"?: string;
}

export interface BrandPoolAdminProps {
  title: string;
  description: ReactNode;
  pool: BrandPool;
  /** 管理页路径（flash 关闭回跳、无 JS 确认链接），如 /admin/logo */
  basePath: string;
  /** 公开输出路由（缩略图），如 /brand/logo */
  previewPath: string;
  /** 缩略图尺寸类（LOGO 方图 / Hero 宽图） */
  previewClassName: string;
  maxBytes: number;
  /** 文件超限提示里的尺寸建议 */
  fileHint: string;
  namePlaceholder: string;
  /** ?err= 的文案表（bad_type / too_large / oversize / forbidden…） */
  errText: Record<string, string>;
  emptyText: string;
  removeTitle: string;
  removeDescription: string;
  /** 池项附加徽标（如 LOGO 的「〈主题〉自带」） */
  itemBadge?: (item: BrandItem) => ReactNode;
  sp: { err?: string; added?: string; "confirm-remove"?: string };
  actions: { upload: FormAction; setActive: FormAction; remove: FormAction };
}

/**
 * 品牌素材池管理页（M10.5 LOGO 版起，M11 泛化给 Hero 共用；S2 后台线稿模式）：
 * 上传入口 + 池卡片网格（当前项高亮 + 设为当前 / 移除）；移除有 ConfirmSubmit 对话框，
 * 无 JS 时走 ?confirm-remove=<file> 的原生表单确认段（role=alertdialog）。
 * 页面本体（requireAdmin 第一个 await、读池、metadata）留在各自 page.tsx。
 */
export function BrandPoolAdmin({
  title,
  description,
  pool,
  basePath,
  previewPath,
  previewClassName,
  maxBytes,
  fileHint,
  namePlaceholder,
  errText,
  emptyText,
  removeTitle,
  removeDescription,
  itemBadge,
  sp,
  actions,
}: BrandPoolAdminProps) {
  const confirmRemove =
    sp["confirm-remove"] && pool.items.some((i) => i.file === sp["confirm-remove"])
      ? pool.items.find((i) => i.file === sp["confirm-remove"])!
      : null;
  const previewUrl = (item: BrandItem, active: boolean) =>
    active ? previewPath : `${previewPath}?file=${encodeURIComponent(item.file)}`;

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </header>

      {sp.err && (
        <AdminFlash kind="error" dismissHref={basePath}>
          {errText[sp.err] ?? "操作失败，请重试。"}
        </AdminFlash>
      )}
      {sp.added && (
        <AdminFlash kind="success" dismissHref={basePath}>
          已入池并设为当前（下方高亮项）。切换其他项请用「设为当前」。
        </AdminFlash>
      )}

      {confirmRemove && (
        <div
          role="alertdialog"
          aria-label="确认移除"
          className="rounded-xl border border-warning/40 bg-warning/10 p-4"
        >
          <p className="text-sm font-medium">无脚本模式 · 确认移除「{confirmRemove.name}」？</p>
          <p className="mt-1 text-xs text-warning">{removeDescription}</p>
          <form action={actions.remove} className="mt-3 flex gap-2">
            <input type="hidden" name="file" value={confirmRemove.file} />
            <SubmitButton className="rounded-lg bg-destructive px-4 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60">
              确认移除
            </SubmitButton>
          </form>
        </div>
      )}

      {/* 上传 */}
      <Card>
        <CardContent className="pt-5">
          <form action={actions.upload} className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              名称
              <input
                name="name"
                maxLength={40}
                placeholder={namePlaceholder}
                className="w-48 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <BrandFileInput maxBytes={maxBytes} hint={fileHint} />
            <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              <Upload className="mr-1 inline size-4" aria-hidden /> 上传入池
            </SubmitButton>
          </form>
        </CardContent>
      </Card>

      {/* 池网格 */}
      {pool.items.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card/50 px-6 py-10 text-center text-sm text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pool.items.map((item) => {
            const active = pool.active === item.file;
            return (
              <Card key={item.file} className={active ? "border-primary/60" : undefined}>
                <CardContent className="flex items-center gap-3 pt-5">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 管理页缩略图走公开品牌路由（池内项为管理员可见） */}
                  <img
                    src={previewUrl(item, active)}
                    alt={item.name}
                    className={`${previewClassName} shrink-0 rounded-lg border`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    {itemBadge?.(item)}
                    {active && (
                      <p className="mt-0.5 flex items-center gap-0.5 text-xs text-primary">
                        <CheckCircle2 className="size-3.5 shrink-0" aria-hidden /> 当前生效中
                      </p>
                    )}
                    <p className="truncate text-xs text-muted-foreground">{item.file}</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1.5">
                    {!active && (
                      <form action={actions.setActive}>
                        <input type="hidden" name="file" value={item.file} />
                        <SubmitButton className="w-full rounded-md border px-2.5 py-1 text-xs hover:bg-accent">
                          设为当前
                        </SubmitButton>
                      </form>
                    )}
                    <form action={actions.remove}>
                      <input type="hidden" name="file" value={item.file} />
                      <ConfirmSubmit
                        title={removeTitle}
                        description={removeDescription}
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
