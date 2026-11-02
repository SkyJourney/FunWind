import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz/require-admin";
import { getDecorPoolRaw } from "@/lib/brand/decor-pool";
import { getLogoPoolRaw } from "@/lib/brand/logo-pool";
import { getDecorUsage, getThemePack, parseThemePackAssets } from "@/lib/theme/packs";
import { SURFACES, type ThemePackDefinition } from "@/lib/theme/surface-schema";
import { AdminFlash } from "@/components/admin/admin-flash";
import { ThemePackEditor } from "@/components/admin/theme-pack-editor";
import { ThemeLogoManager } from "@/components/admin/theme-logo-manager";
import { startThemePreviewAction } from "@/app/theme-preview-actions";
import { saveThemePackAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "编辑主题包" };

const ERR_TEXT: Record<string, string> = {
  conflict: "包已被他人修改（版本冲突）——请刷新页面后重试，避免覆盖对方的改动。",
  "invalid-definition": "包配置校验未通过，请检查分区定义。",
  "bad-json": "包配置不是合法 JSON。",
  "bad-name": "主题名称不能为空。",
  "not-found": "包不存在。",
  protected: "该包受保护，不能这样修改。",
  "missing-assets": "配置引用了不存在的装饰素材，请先到装饰素材池补齐文件。",
};

/**
 * 主题包编辑页（M11.1 Step 5b）：按 Surface 分区编辑 + 实时预览（草稿不落库）。
 * 保存走 saveThemePackAction（服务端 strict zod 校验 + revision 乐观锁 + 审计）。
 */
export default async function ThemePackEditPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; err?: string }>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  const { id } = await props.params;
  const sp = await props.searchParams;
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
    <div className="space-y-4">
      <header>
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
      {sp.err && (
        <AdminFlash kind="error" dismissHref={`/admin/themes/${pack.id}`}>
          {ERR_TEXT[sp.err] ?? "保存失败，请重试。"}
        </AdminFlash>
      )}

      {/* 全站预览（M11.1 Step 7）：10 分钟签名 cookie，仅本人浏览器按该包渲染，不落库 */}
      <form
        action={startThemePreviewAction}
        className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-3"
      >
        <input type="hidden" name="packId" value={pack.id} />
        <p className="text-xs text-muted-foreground">
          想看整站效果？开启后本浏览器 10 分钟内按此主题渲染全站（不影响其他访客，也不写入配置）。
        </p>
        <button
          type="submit"
          className="ml-auto rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-accent"
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

      <form action={saveThemePackAction}>
        <input type="hidden" name="id" value={pack.id} />
        <input type="hidden" name="revision" value={pack.revision} />
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            主题名称
            <input
              name="name"
              required
              maxLength={60}
              defaultValue={pack.name}
              className="rounded-lg border bg-background px-3 py-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            说明
            <input
              name="description"
              maxLength={200}
              defaultValue={pack.description}
              className="rounded-lg border bg-background px-3 py-2"
            />
          </label>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          图片底纹与内容插槽引用装饰素材池中的文件。
          <Link href="/admin/decor" className="text-primary underline">
            上传或管理装饰素材
          </Link>
          。
        </p>
        <ThemePackEditorForm
          surfaces={SURFACES.map((s) => ({ id: s.id, label: s.label, caps: s.caps }))}
          initialDefinition={pack.definition as ThemePackDefinition}
          fallbackDefinition={defaultPack?.definition as ThemePackDefinition | undefined}
          decorFiles={decor.items.map((i) => ({ file: i.file, name: i.name }))}
          decorUsage={decorUsage}
        />
        <div className="mt-4 flex gap-2">
          <button
            type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            保存主题包
          </button>
          <Link
            href="/admin/themes"
            className="rounded-lg border px-4 py-2 text-sm hover:bg-accent"
          >
            返回列表
          </Link>
        </div>
      </form>
    </div>
  );
}

/**
 * 编辑器 + 隐藏的 definition 字段（客户端）：编辑器把草稿 definition 同步到隐藏 input，
 * 提交时随表单一起送到服务端校验。
 */
function ThemePackEditorForm(props: {
  surfaces: readonly { id: string; label: string; caps: readonly string[] }[];
  initialDefinition: ThemePackDefinition;
  fallbackDefinition?: ThemePackDefinition;
  decorFiles: readonly { file: string; name: string }[];
  decorUsage: ReadonlyMap<string, { packId: string; packName: string; surfaceIds: string[] }[]>;
}) {
  return (
    <ThemePackEditor
      surfaces={props.surfaces}
      initialDefinition={props.initialDefinition}
      fallbackDefinition={props.fallbackDefinition}
      decorFiles={props.decorFiles}
      decorUsage={props.decorUsage}
    />
  );
}
