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
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* 文档站顶条：标识 + 主题切换 + 移动端导航呼出 */}

      {/* lg：左树导航 + 右内容流；<lg 由顶条汉堡抽屉承载 */}
      <div className="lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-10">
        <aside aria-label="文档导航" className="hidden lg:block">
          <div className="sticky top-16">
            <DocsNav />
          </div>
        </aside>

        <div className="min-w-0 space-y-10">
          {DOCS_SECTIONS.map((section) => (
            <Section key={section.slug} slug={section.slug} md={section.md} />
          ))}
          <p className="border-t pt-4 text-xs text-muted-foreground">
            本页数据源：<code className="font-mono">lib/manage/api-docs-md.ts</code>
            （端点实现变更须同步）；人读契约 <code className="font-mono">docs/MANAGE-API.md</code>；
            渲染走站内 markdown 管线（表格 / 代码围栏 / 暗色令牌自适应）。
          </p>
        </div>
      </div>
    </div>
  );
}
