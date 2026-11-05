import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz/require-admin";
import { getDecorPoolRaw } from "@/lib/brand/decor-pool";
import { getLogoPoolRaw } from "@/lib/brand/logo-pool";
import { MAX_ISSUES_SHOWN, parseIssues } from "@/lib/theme/issues";
import { getDecorUsage, getThemePack, parseThemePackAssets } from "@/lib/theme/packs";
import { SURFACES, type ThemePackDefinition } from "@/lib/theme/surface-schema";
import { AdminFlash } from "@/components/admin/admin-flash";
import { describeIssue } from "@/components/admin/theme/issue-text";
import { ThemePackEditorForm } from "@/components/admin/theme-pack-editor-form";
import { ThemeLogoManager } from "@/components/admin/theme-logo-manager";
import { startThemePreviewAction } from "@/app/theme-preview-actions";
import { saveThemePackAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "编辑主题包" };

const ERR_TEXT: Record<string, string> = {
  conflict:
    "包已被他人修改（版本冲突）。草稿与原始提交版本会保留；刷新或再次保存不会自动覆盖他人的改动。请先保留需要的内容，再明确载入最新版本并重新编辑。",
  "invalid-definition": "包配置校验未通过，请检查分区定义。",
  "bad-json": "包配置不是合法 JSON。",
  "bad-name": "主题名称不能为空。",
  "not-found": "包不存在。",
  protected: "该包受保护，不能这样修改。",
  "missing-assets": "配置引用了不存在的装饰素材，请先到装饰素材池补齐文件。",
  "capacity-unavailable": "系统回退主题包缺失，无法校验容量；请先完成数据库初始化。",
};

/**
 * 主题包编辑页（M11.1 Step 5b）：按 Surface 分区编辑 + 实时预览（草稿不落库）。
 * 保存走 saveThemePackAction（服务端 strict zod 校验 + revision 乐观锁 + 审计）。
 */
export default async function ThemePackEditPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; err?: string; ack?: string; issue?: string | string[] }>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  const actor = await requireAdmin("site.admin");
  const { id } = await props.params;
  const sp = await props.searchParams;
  // 具体问题只在「校验未通过」时有意义；别的错误码带了 issue 也不显示（查询参数不可信）
  const issues = sp.err === "invalid-definition" ? parseIssues(sp.issue) : [];
  const pack = await getThemePack(id);
  if (!pack) notFound();
  const [decor, defaultPack, decorUsage, logoPool] = await Promise.all([
    getDecorPoolRaw(),
    getThemePack("default"),
    getDecorUsage(),
    getLogoPoolRaw(),
  ]);
  const boundLogo =
    parseThemePackAssets(pack.assets).find((asset) => asset.kind === "logo")?.poolFile ?? null;

  return (
    <div className="max-w-full min-w-0 space-y-4">
      <header className="min-w-0 [overflow-wrap:anywhere]">
        <h2 className="text-lg font-bold tracking-tight">编辑主题包 · {pack.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {pack.id} · 版本 v{pack.revision}
          {pack.isBuiltin ? " · 内置包（可编辑，不可删除）" : ""}
        </p>
      </header>

      {sp.saved && (
        <AdminFlash kind="success" dismissHref={`/admin/themes/${pack.id}`}>
          主题包配置已保存。
        </AdminFlash>
      )}
      {sp.err && <AdminFlash kind="error">{ERR_TEXT[sp.err] ?? "保存失败，请重试。"}</AdminFlash>}
      {issues.length > 0 && (
        <ul
          aria-label="未通过校验的项"
          className="max-w-full min-w-0 space-y-1 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          {issues.slice(0, MAX_ISSUES_SHOWN).map((issue, index) => (
            <li key={`${index}:${issue}`} className="[overflow-wrap:anywhere]">
              {describeIssue(issue)}
            </li>
          ))}
          {issues.length > MAX_ISSUES_SHOWN && <li>还有更多问题未列出，改好上面的再保存。</li>}
        </ul>
      )}

      {/* 全站预览（M11.1 Step 7）：10 分钟签名 cookie，仅本人浏览器按该包渲染，不落库 */}
      <form
        action={startThemePreviewAction}
        className="flex max-w-full min-w-0 flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-3"
      >
        <input type="hidden" name="packId" value={pack.id} />
        <p className="min-w-0 text-xs [overflow-wrap:anywhere] text-muted-foreground">
          想看整站效果？开启后本浏览器 10 分钟内按此主题渲染全站（不影响其他访客，也不写入配置）。
        </p>
        <button
          type="submit"
          className="ml-auto shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium whitespace-nowrap hover:bg-accent"
        >
          全站预览此主题
        </button>
      </form>

      <ThemeLogoManager
        packId={pack.id}
        initialLogo={boundLogo}
        poolItems={logoPool.items}
        canManage={logoPool.items.length > 0}
      />

      <ThemePackEditorForm
        action={saveThemePackAction}
        userId={actor.userId}
        packId={pack.id}
        revision={pack.revision}
        name={pack.name}
        description={pack.description}
        initialDefinition={pack.definition as ThemePackDefinition}
        error={sp.err}
        saved={Boolean(sp.saved)}
        ack={sp.ack}
        surfaces={SURFACES.map((surface) => ({
          id: surface.id,
          label: surface.label,
          caps: surface.caps,
        }))}
        fallbackDefinition={defaultPack?.definition as ThemePackDefinition | undefined}
        decorFiles={decor.items.map((item) => ({ file: item.file, name: item.name }))}
        decorUsage={decorUsage}
      />
    </div>
  );
}
