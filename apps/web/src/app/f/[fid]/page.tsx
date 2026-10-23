import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ThreadRow } from "@/components/content/thread-row";
import { Pagination } from "@/components/content/pagination";
import { getAllForums, getForum, getForumThreadCounts } from "@/lib/queries/forums";
import { getLatestThreads, getTopicTypes, listThreads } from "@/lib/queries/threads";
import { getCurrentUser } from "@/lib/auth/session";
import { checkPermission } from "@/lib/authz/service";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ fid: string }>;
  searchParams: Promise<{ page?: string; type?: string }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { fid } = await params;
  const forum = await getForum(Number(fid));
  return { title: forum?.name ?? "版块" };
}

export default async function ForumPage({ params, searchParams }: Params) {
  const { fid: fidRaw } = await params;
  const { page: pageRaw, type: typeRaw } = await searchParams;
  const fid = Number(fidRaw);
  if (!Number.isInteger(fid) || fid <= 0) notFound();

  const forum = await getForum(fid);
  if (!forum) notFound();
  if (forum.type === "category") {
    // 分类版块无主题：跳回首页目录
    notFound();
  }

  // 版块读取权限（M5）：DENY → 404（不暴露受限版块存在性）
  const user = await getCurrentUser();
  const read = await checkPermission(user?.id ?? null, "forum.read", { forumId: fid });
  if (!read.allowed) notFound();

  const page = Math.max(1, Number(pageRaw ?? "1") || 1);
  const typeId = Number(typeRaw ?? "0") || 0;

  const [types, { items, total, page: safePage, totalPages }] = await Promise.all([
    getTopicTypes(fid),
    listThreads(fid, { page, typeId }),
  ]);
  const [allForums, counts, latest] = await Promise.all([
    getAllForums(),
    getForumThreadCounts(),
    getLatestThreads(5), // 侧栏：全站最新（后续里程碑替换为本版统计）
  ]);
  const parent = forum.parentId > 0 ? allForums.find((r) => r.id === forum.parentId) : undefined;
  const category =
    parent?.type === "category"
      ? parent
      : allForums.find((r) => r.type === "category" && r.id === forum.parentId);

  const basePath = `/f/${fid}${typeId > 0 ? `?type=${typeId}` : ""}`;

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/" className="inline-flex items-center gap-1 hover:text-primary">
          <ArrowLeft className="size-3.5" /> 首页
        </Link>
        {category && <span>/</span>}
        {category && <span>{category.name}</span>}
        <span>/</span>
        <span className="text-foreground">{forum.name}</span>
      </nav>

      <header>
        <h1
          className="text-2xl font-bold tracking-tight"
          style={
            forum.nameStyle.match(/color:\s*([^;"]+)/)?.[1]
              ? { color: forum.nameStyle.match(/color:\s*([^;"]+)/)![1] }
              : undefined
          }
        >
          {forum.name}
        </h1>
        {forum.description && (
          <p className="mt-1 text-sm text-muted-foreground">{forum.description}</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">主题 {counts.get(forum.id) ?? 0}</p>
      </header>

      {types.length > 0 && (
        <nav className="flex flex-wrap gap-1.5" aria-label="主题分类">
          <Link
            href={`/f/${fid}`}
            className={`rounded-full border px-3 py-1 text-xs ${typeId === 0 ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
          >
            全部
          </Link>
          {types.map((t) => (
            <Link
              key={t.id}
              href={`/f/${fid}?type=${t.id}`}
              className={`rounded-full border px-3 py-1 text-xs ${typeId === t.id ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {t.name}
            </Link>
          ))}
        </nav>
      )}

      <section>
        <div className="border-b pb-2 text-xs text-muted-foreground">
          共 {total} 个主题 · 第 {safePage}/{totalPages} 页
        </div>
        {items.map((t) => (
          <ThreadRow key={t.id} thread={t} />
        ))}
        {items.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            该版块暂无主题（或筛选条件下无结果）。
          </p>
        )}
      </section>

      <Pagination basePath={basePath} page={safePage} totalPages={totalPages} />

      <aside className="border-t pt-4">
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">全站最新</h2>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {latest.map((t) => (
            <Link
              key={t.id}
              href={`/t/${t.id}`}
              className="text-muted-foreground hover:text-primary"
            >
              {t.title.slice(0, 18)}
            </Link>
          ))}
        </div>
      </aside>
    </main>
  );
}
