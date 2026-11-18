import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz/require-admin";
import { isEffectiveSiteAdminOf } from "@/lib/manage/tokens";
import { DOCS_SECTIONS } from "@/lib/manage/api-docs-md";
import { RichContent } from "@/components/content/rich-content";
import { DocsNav } from "./docs-nav";

export const dynamic = "force-dynamic";
export const metadata = { title: "FunWind REST API 文档" };

/** 内容节渲染：md → 站内渲染管线（表格 / 代码围栏 / 暗色适配全继承） */
function Section({ slug, md }: { slug: string; md: string }) {
  return (
    <section id={slug} className="scroll-mt-20">
      <RichContent md={md} className="docs-md" />
    </section>
  );
}

/**
 * 管理 REST API 在线文档（M20.1，独立路由 /docs/rest-api）：不套前台/后台壳的独立文档站。
 * 内容全部 markdown 化（api-docs-md.ts）→ 站内 renderMarkdown 管线统一渲染；
 * 门禁与 API 令牌页同口径（requireAdmin + 不变量校验）；后台入口在 API 令牌页底部（新窗口）。
 */
export default async function RestApiDocsPage() {
  const admin = await requireAdmin("site.admin");
  if (!(await isEffectiveSiteAdminOf(admin.userId))) notFound();

  return (
    <div className="mx-auto h-full max-w-7xl px-4 pb-6 sm:px-6">
      {/* 双栏独立滚动（站长验收意见的完整形态）：左右栏各自的滚动条完全隔离，永不联动——
          左树超长在左栏内部滚、正文超长在右栏内部滚；顶条与容器外壳固定不滚 */}
      <div className="grid h-full grid-cols-1 gap-10 overflow-y-auto lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-10 lg:overflow-hidden">
        {/* 左树：仅桌面显示（移动端走顶条汉堡抽屉）；全列高内部滚动，顶部固定间隔由 pt 承担 */}
        <aside
          aria-label="文档导航"
          className="hidden overflow-y-auto pt-8 pr-2 lg:block lg:h-full"
        >
          <DocsNav />
        </aside>

        {/* 正文列：独立滚动；顶部呼吸间距由 pt 承担 */}
        <div className="min-w-0 overflow-y-auto pt-8 pb-6 lg:pr-2">
          <div className="mb-8 space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">FunWind REST API</h1>
          </div>
          {DOCS_SECTIONS.map((section) => (
            <Section key={section.slug} slug={section.slug} md={section.md} />
          ))}
        </div>
      </div>
    </div>
  );
}
