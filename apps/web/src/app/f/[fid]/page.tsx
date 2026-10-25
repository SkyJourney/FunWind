import { ArrowLeft, Trophy } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ThreadRow } from "@/components/content/thread-row";
import { Pagination } from "@/components/content/pagination";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getForumTree } from "@/lib/authz/snapshot";
import { loadComposeAccess } from "@/lib/posting/compose-access";
import { forumTagCloud, tagByName } from "@/lib/interact/tags";
import { isFollowing } from "@/lib/interact/follows";
import { FollowButton } from "@/components/interact/follow-button";
import { getCurrentUser } from "@/lib/auth/session";
import { getForumView } from "@/lib/queries/forums";
import { getLatestThreads, listThreads } from "@/lib/queries/threads";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ fid: string }>;
  searchParams: Promise<{ page?: string; type?: string; tag?: string }>;
};

const parseFid = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const fid = parseFid((await params).fid);
  // 与页面同一套权限：读不到的版块给通用标题，名称不经 <title> 泄露
  const forum = fid ? await getForumView(await getCurrentSubject(), fid) : null;
  return { title: forum?.name ?? "版块" };
}

export default async function ForumPage({ params, searchParams }: Params) {
  const fid = parseFid((await params).fid);
  if (!fid) notFound();
  const { page: pageRaw, type: typeRaw, tag: tagRaw } = await searchParams;

  const viewer = await getCurrentSubject();
  const forum = await getForumView(viewer, fid);
  // 不存在 / 读不到 / 是分区（无主题）→ 一律 404，不暴露受限版块的存在
  if (!forum || forum.kind === "section") notFound();

  const prefixId = Number(typeRaw ?? "0") || 0;
  const tag = typeof tagRaw === "string" && tagRaw ? await tagByName(tagRaw) : null;
  const [list, latest, tree, access, tagCloud] = await Promise.all([
    listThreads(viewer, fid, {
      page: Math.max(1, Number(pageRaw ?? "1") || 1),
      prefixId,
      tagId: tag?.id,
    }),
    getLatestThreads(viewer, 5),
    getForumTree(),
    loadComposeAccess(viewer, fid, forum.kind),
    forumTagCloud(fid),
  ]);
  const user = await getCurrentUser();
  const following = user !== null && (await isFollowing(user.id, "forum", fid));
  const basePath = `/f/${fid}${prefixId > 0 ? `?type=${prefixId}` : ""}${tag ? `&tag=${encodeURIComponent(tag.name)}` : ""}`;

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/" className="inline-flex items-center gap-1 hover:text-primary">
          <ArrowLeft className="size-3.5" /> 首页
        </Link>
        {forum.trail.map((t) => (
          <span key={t.id} className="inline-flex items-center gap-1.5">
            <span>/</span>
            {t.kind === "section" ? (
              <span>{t.name}</span>
            ) : (
              <Link href={`/f/${t.id}`} className="hover:text-primary">
                {t.name}
              </Link>
            )}
          </span>
        ))}
        <span>/</span>
        <span className="text-foreground">{forum.name}</span>
      </nav>

      <header>
        <h1 className="text-2xl font-bold tracking-tight">{forum.name}</h1>
        {forum.description && (
          <p className="mt-1 text-sm text-muted-foreground">{forum.description}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>主题 {forum.threadCount}</span>
          {access.mode === "form" && (
            <Link href={`/f/${fid}/new`} className="font-medium text-primary hover:underline">
              发新主题
            </Link>
          )}
          {user && (
            <FollowButton
              targetType="forum"
              targetId={fid}
              following={following}
              back={`/f/${fid}`}
            />
          )}
        </div>
      </header>

      {tagCloud.length > 0 && (
        <nav className="flex flex-wrap gap-1.5" aria-label="标签云">
          {tagCloud.map((t) => (
            <Link
              key={t.id}
              href={`/f/${fid}?tag=${encodeURIComponent(t.name)}`}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                tag?.id === t.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-primary"
              }`}
            >
              #{t.name} <span className="opacity-70">{t.count}</span>
            </Link>
          ))}
        </nav>
      )}

      {tagRaw !== undefined && !tag && (
        <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
          没有名为「{tagRaw}」的标签。
        </p>
      )}

      {forum.prefixes.length > 0 && (
        <nav className="flex flex-wrap gap-1.5" aria-label="主题分类">
          <Link
            href={`/f/${fid}`}
            className={`rounded-full border px-3 py-1 text-xs ${prefixId === 0 ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
          >
            全部
          </Link>
          {forum.prefixes.map((p) => (
            <Link
              key={p.id}
              href={`/f/${fid}?type=${p.id}`}
              className={`rounded-full border px-3 py-1 text-xs ${prefixId === p.id ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {p.name}
            </Link>
          ))}
        </nav>
      )}

      {list.pinned.length > 0 && (
        <section aria-label="置顶主题" className="rounded-xl border bg-muted/30 px-4">
          <h2 className="flex items-center gap-1 pt-2 text-xs font-semibold text-muted-foreground">
            <Trophy className="size-3.5" /> 置顶
          </h2>
          {list.pinned.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              showForum={t.forumId !== fid}
              forumName={tree.get(t.forumId)?.name}
            />
          ))}
        </section>
      )}

      <section>
        <div className="border-b pb-2 text-xs text-muted-foreground">
          共 {list.total} 个主题 · 第 {list.page}/{list.totalPages} 页
        </div>
        {list.items.map((t) => (
          <ThreadRow key={t.id} thread={t} />
        ))}
        {list.items.length === 0 && list.pinned.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            该版块暂无主题（或筛选条件下无结果）。
          </p>
        )}
      </section>

      <Pagination basePath={basePath} page={list.page} totalPages={list.totalPages} />

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
