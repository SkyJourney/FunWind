import { requireAdmin } from "@/lib/authz/require-admin";
import {
  getEnabledThemePackCount,
  getSiteDefaultThemePack,
  getThemePack,
  listThemePacks,
  MAX_ENABLED_THEME_PACKS,
} from "@/lib/theme/packs";
import { SURFACES } from "@/lib/theme/surface-schema";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { AdminFlash } from "@/components/admin/admin-flash";
import { ThemePackImportForm } from "@/components/admin/theme-pack-import-form";
import {
  copyThemePackAction,
  createThemePackAction,
  deleteThemePackAction,
  setDefaultThemePackAction,
  toggleThemePackAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "主题包" };

const FLASH: Record<string, string> = {
  created: "主题包已创建。",
  copied: "主题包已复制。",
  deleted: "主题包已删除。",
  toggled: "主题包状态已更新。",
  default: "已设为全站默认主题。",
  default_logo: "已设为全站默认主题，并把 LOGO 切换为该主题自带图（可在「LOGO 管理」独立改回）。",
  default_no_logo: "已设为全站默认主题（此主题无自带 LOGO，LOGO 保持不变）。",
  imported: "主题包及其素材已导入。",
};

const ERR_TEXT: Record<string, string> = {
  "bad-id": "包 id 只能用小写字母、数字、下划线与短横线（2–32 位）。",
  "bad-name": "主题名称不能为空。",
  "reserved-id": "该 id 是系统保留字（default / dark / system），请换一个。",
  "duplicate-id": "同名包已存在。",
  "not-found": "包不存在。",
  conflict: "包已被他人修改（版本冲突）——请刷新页面后重试，避免覆盖对方的改动。",
  protected: "系统回退包或内置包不可删除/停用。",
  "invalid-definition": "包配置校验未通过，请检查分区定义（颜色须为 #RRGGBB、字段不可未知）。",
  "bad-json": "包配置不是合法 JSON。",
  "missing-assets": "配置引用了不存在的装饰素材，请先到装饰素材池补齐文件。",
  "bad-archive": "主题包文件损坏、版本不支持或包含不安全内容。",
  "archive-too-large": "主题包文件为空或超过 20MB 上限。",
  "asset-import": "包内图片未通过素材池校验，主题包未创建。",
  "enabled-limit": `全站最多启用 ${MAX_ENABLED_THEME_PACKS} 个主题包（含内置包）；请先停用一个，再重试。`,
  "capacity-unavailable": "系统回退主题包缺失，无法校验容量；请先完成数据库初始化。",
};

/**
 * 主题包管理（M11.1 Step 5，docs/milestones/M11.1-theme-engine.md）：
 * 列表（启停/复制/删除/设为默认）+ 新建；每包进入编辑页做分区定制。
 * 门禁 site.admin；写操作走 lib/theme/packs（事务 + 审计 + revision 乐观锁）。
 */
export default async function ThemesAdminPage(props: {
  searchParams: Promise<{ saved?: string; err?: string; id?: string; warn?: string }>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  const sp = await props.searchParams;
  const [packs, defaultPackId, starterPack, enabledPackCount] = await Promise.all([
    listThemePacks(),
    getSiteDefaultThemePack(),
    getThemePack("default"),
    getEnabledThemePackCount(),
  ]);

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-bold tracking-tight">主题管理</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          主题包 =
          一套区域外观定义（配色、渐变、遮罩、图片底纹等）。可新建、编辑、启停、导入导出并设置站点默认；
          保存后全站即时生效（SSR 注入），用户也可在「外观」或顶栏菜单自选。
        </p>
      </header>

      {sp.saved && (
        <AdminFlash kind="success" dismissHref="/admin/themes">
          {FLASH[sp.saved] ?? "操作已完成。"}
        </AdminFlash>
      )}
      {sp.err && (
        <AdminFlash kind="error" dismissHref="/admin/themes">
          {ERR_TEXT[sp.err] ?? "操作失败，请重试。"}
        </AdminFlash>
      )}
      {sp.warn === "import-cleanup" && (
        <AdminFlash kind="warning" dismissHref="/admin/themes">
          {sp.saved === "imported"
            ? "主题包已导入，但素材池当前项恢复失败；请检查服务器日志及素材池设置。"
            : "主题包未创建，且部分素材清理或素材池当前项恢复失败；请检查服务器日志及素材池。"}
        </AdminFlash>
      )}
      {sp.warn === "logo" && (
        <AdminFlash kind="warning" dismissHref="/admin/themes">
          默认主题已保存，但自带 LOGO 未能切换；可在 LOGO 管理中手动设置。
        </AdminFlash>
      )}
      <p className="text-sm text-muted-foreground" data-testid="theme-pack-capacity">
        已启用主题包：{enabledPackCount} / {MAX_ENABLED_THEME_PACKS}
      </p>

      {/* 新建 */}
      <Card>
        <CardContent className="pt-5">
          <form action={createThemePackAction} className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              包 id
              <input
                name="id"
                required
                maxLength={32}
                pattern="[a-z0-9][a-z0-9_-]{1,31}"
                placeholder="如：paper-warm"
                className="w-44 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="grid gap-1 text-sm">
              名称
              <input
                name="name"
                required
                maxLength={60}
                placeholder="如：暖纸"
                className="w-44 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="grid gap-1 text-sm">
              说明
              <input
                name="description"
                maxLength={200}
                placeholder="可选"
                className="w-56 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <input
              type="hidden"
              name="definition"
              value={JSON.stringify(starterPack?.definition ?? { surfaces: {} })}
            />
            <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              新建主题包
            </SubmitButton>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            可定制区域（{SURFACES.map((s) => s.label).join("、")}）——新建后在编辑页逐区配置。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <h3 className="text-sm font-semibold">导入主题包</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            ZIP 包含版本化 JSON 与 PNG 资源；导入时会重新验图并复制到本站素材池，不会执行
            CSS、脚本或外链。
          </p>
          <ThemePackImportForm />
        </CardContent>
      </Card>

      {/* 列表 */}
      {packs.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card/50 px-6 py-10 text-center text-sm text-muted-foreground">
          还没有主题包——先新建一个，或到「站点配置」里选内置主题。
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {packs.map((pack) => {
            const isDefault = defaultPackId === pack.id;
            return (
              <Card key={pack.id}>
                <CardContent className="pt-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{pack.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {pack.id} · {pack.surfaces} 个区域 · {pack.assetCount} 项素材 · v
                        {pack.revision}
                      </p>
                      {pack.description && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {pack.description}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {pack.isBuiltin && (
                        <span className="rounded bg-accent px-1.5 py-0.5 text-[11px] text-accent-foreground">
                          内置
                        </span>
                      )}
                      {isDefault && (
                        <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[11px] text-primary">
                          全站默认
                        </span>
                      )}
                      {!pack.enabled && (
                        <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning">
                          已停用
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <a
                      href={`/admin/themes/${pack.id}`}
                      className="rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
                    >
                      编辑
                    </a>
                    <a
                      href={`/admin/themes/${pack.id}/export`}
                      className="rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
                    >
                      导出 ZIP
                    </a>
                    {!isDefault && (
                      <form action={setDefaultThemePackAction}>
                        <input type="hidden" name="id" value={pack.id} />
                        <SubmitButton className="rounded-md border px-2.5 py-1 text-xs hover:bg-accent">
                          设为默认
                        </SubmitButton>
                      </form>
                    )}
                    <form action={toggleThemePackAction}>
                      <input type="hidden" name="id" value={pack.id} />
                      <input type="hidden" name="enabled" value={pack.enabled ? "0" : "1"} />
                      <SubmitButton
                        disabled={pack.id === "default"}
                        className="rounded-md border px-2.5 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {pack.id === "default" ? "不可停用" : pack.enabled ? "停用" : "启用"}
                      </SubmitButton>
                    </form>
                    {!pack.isBuiltin && (
                      <form action={copyThemePackAction}>
                        <input type="hidden" name="sourceId" value={pack.id} />
                        <SubmitButton className="rounded-md border px-2.5 py-1 text-xs hover:bg-accent">
                          复制
                        </SubmitButton>
                      </form>
                    )}
                    {!pack.isBuiltin && (
                      <form action={deleteThemePackAction}>
                        <input type="hidden" name="id" value={pack.id} />
                        <ConfirmSubmit
                          title="删除这个主题包？"
                          description="删除后引用它的用户偏好会回退到默认主题；此操作不可撤销（文件与审计保留）。"
                          className="rounded-md border px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10"
                          pendingText="删除中…"
                        >
                          删除
                        </ConfirmSubmit>
                      </form>
                    )}
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
