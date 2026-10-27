import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { ThreadRow } from "@/components/content/thread-row";
import { Pagination } from "@/components/content/pagination";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getForumTree } from "@/lib/authz/snapshot";
import { cleanQuery, searchThreads } from "@/lib/queries/search";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "搜索" };

type Params = {
  searchParams: Promise<{ q?: string; page?: string; sort?: string }>;
};

/** 站内搜索页（M8）：分页 / 时间排序切换 / 空结果引导；可见性由查询层硬约束 */
export default async function SearchPage({ searchParams }: Params) {
  const sp = await searchParams;
  const q = cleanQuery(typeof sp.q === "string" ? sp.q : "");
  const sort = sp.sort === "time" ? "time" : "relevance";
  const viewer = await getCurrentSubject();

  const [result, tree] = await Promise.all([
    searchThreads(viewer, q, { page: Math.max(1, Number(sp.page ?? "1") || 1), sort }),
    getForumTree(),
  ]);

  const baseParams = (over: Record<string, string | number>) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (sort !== "relevance") p.set("sort", sort);
    for (const [k, v] of Object.entries(over)) p.set(k, String(v));
    const s = p.toString();
    return s ? `/search?${s}` : "/search";
  };

  return (
    <main className="mx-auto max-w-4xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
      <header className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">搜索</h1>
        <form action="/search" method="get" className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="搜索主题标题与帖子正文"
              maxLength={64}
              className="w-full rounded-lg border bg-background py-2 pr-3 pl-9 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {sort !== "relevance" && <input type="hidden" name="sort" value={sort} />}
          <button
            type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            搜索
          </button>
        </form>
        {q && (
          <p className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>
              「{q}」共 {result.total} 个主题
            </span>
            <Link
              href={baseParams({ sort: sort === "relevance" ? "time" : "relevance", page: 1 })}
              className="text-primary hover:underline"
            >
              {sort === "relevance" ? "按时间排序" : "按相关度排序"}
            </Link>
          </p>
        )}
      </header>

      {!q ? (
        <EmptyState
          icon={Search}
          title="输入关键词搜索全站的主题与帖子。"
          description="支持中日文。"
        />
      ) : result.hits.length === 0 ? (
        <EmptyState
          icon={Search}
          title={`没有找到与「${q}」相关的内容。`}
          description="试试更短的关键词，或者去版块目录逛逛。"
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/">版块目录</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {result.hits.map((h) => (
            <ThreadRow key={h.id} thread={h} showForum forumName={tree.get(h.forumId)?.name} />
          ))}
        </div>
      )}

      {q && result.totalPages > 1 && (
        <Pagination
          basePath={baseParams({ page: 1 }).replace(/&?page=1$/, "")}
          page={result.page}
          totalPages={result.totalPages}
        />
      )}
    </main>
  );
}
