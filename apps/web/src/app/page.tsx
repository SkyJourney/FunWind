import { Flame, Home, Layers, Newspaper } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Slot } from "@/modules/kernel/slot";
import { FeedCard } from "@/components/content/feed-card";
import { BrandCard } from "@/components/site/site-header";
import { EmptyState } from "@/components/empty-state";
import { isDevEnv } from "@/lib/dev-only";
import { getForumTree } from "@/lib/authz/snapshot";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getDirectory } from "@/lib/queries/forums";
import { getHomeFeed, getHotThreads } from "@/lib/queries/threads";
import { getSiteChrome } from "@/lib/site-chrome";

export const metadata: Metadata = { title: "青翼字幕组" };
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ sec?: string; sort?: string; page?: string }>;

const parseId = (raw: string | undefined): number | undefined => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * 首页 = 全站内容流（M10.5 S5，D1 列表流定稿）：跨版块混排、分区 chips 过滤、
 * 最新回复/最新发布排序、偏移分页；xl 出右信息栏。版块目录在 /boards（底部 Tab「版块」）。
 * 权限口径：目录/流/热帖/统计全部按访客可见性过滤（queries 层统一收口）。
 */
export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const sectionId = parseId(params.sec);
  const sort = params.sort === "new" ? ("new" as const) : ("last" as const);
  const page = Math.max(1, Math.trunc(Number(params.page)) || 1);

  const viewer = await getCurrentSubject();
  const chrome = await getSiteChrome();
  const [tree, dir, feed, hot] = await Promise.all([
    getForumTree(),
    getDirectory(viewer),
    getHomeFeed(viewer, { sectionId, sort, page }),
    getHotThreads(viewer, 5),
  ]);

  const sections = tree
    .roots()
    .filter((n) => n.kind === "section")
    .map((n) => ({ id: n.id, name: n.name }));
  const forumNames = new Map(dir.groups.flatMap((g) => g.forums).map((f) => [f.id, f.name]));
  const subNames = new Map(
    dir.groups.flatMap((g) => g.forums).flatMap((f) => f.subs.map((s) => [s.id, s.name])),
  );
  const feedForumName = (fid: number) => forumNames.get(fid) ?? subNames.get(fid);
  const topForums = [...forumNames.entries()].map(([id, name]) => ({ id, name })).slice(0, 8);

  const feedHref = (over: { sec?: number | undefined; sort?: string; page?: number }) => {
    const q = new URLSearchParams();
    const sec = "sec" in over ? over.sec : sectionId;
    const st = over.sort ?? sort;
    const pg = over.page ?? 1;
    if (sec) q.set("sec", String(sec));
    if (st !== "last") q.set("sort", st);
    if (pg > 1) q.set("page", String(pg));
    const qs = q.toString();
    return qs ? `/?${qs}` : "/";
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <h1 className="sr-only">青翼字幕组</h1>

      <Slot name="home.after-header" />

      <div className="mt-4 grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-4">
          {/* 分区筛选 + 排序 */}
          <div className="flex items-center gap-2">
            <nav aria-label="分区筛选" className="flex flex-1 flex-wrap gap-1.5">
              <Link
                href={feedHref({ sec: undefined, page: 1 })}
                aria-current={!sectionId ? "true" : undefined}
                className={`rounded-full border px-3 py-1.5 text-[13px] transition-colors hover:bg-accent ${
                  !sectionId
                    ? "border-primary bg-primary font-medium text-primary-foreground"
                    : "border-border bg-card text-muted-foreground"
                }`}
              >
                全部
              </Link>
              {sections.map((s) => (
                <Link
                  key={s.id}
                  href={feedHref({ sec: s.id, page: 1 })}
                  aria-current={sectionId === s.id ? "true" : undefined}
                  className={`rounded-full border px-3 py-1.5 text-[13px] transition-colors hover:bg-accent ${
                    sectionId === s.id
                      ? "border-primary bg-primary font-medium text-primary-foreground"
                      : "border-border bg-card text-muted-foreground"
                  }`}
                >
                  {s.name}
                </Link>
              ))}
            </nav>
            <div className="hidden shrink-0 items-center gap-1 text-[13px] sm:flex">
              <Link
                href={feedHref({ sort: "last", page: 1 })}
                aria-current={sort === "last" ? "true" : undefined}
                className={`rounded-md px-2 py-1 transition-colors ${
                  sort === "last"
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                最新回复
              </Link>
              <Link
                href={feedHref({ sort: "new", page: 1 })}
                aria-current={sort === "new" ? "true" : undefined}
                className={`rounded-md px-2 py-1 transition-colors ${
                  sort === "new"
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                最新发布
              </Link>
            </div>
          </div>

          <h2 className="sr-only">最新主题</h2>

          {feed.items.length === 0 ? (
            <EmptyState
              icon={Newspaper}
              title="这里还没有主题"
              description={
                sectionId ? "这个分区暂时没有新内容，看看其它分区吧" : "去版块里发第一帖"
              }
              action={
                <Link href="/boards" className="text-sm text-primary hover:underline">
                  浏览版块 →
                </Link>
              }
            />
          ) : (
            <div className="grid gap-2.5">
              {feed.items.map((item, index) => (
                <div
                  key={item.id}
                  className={page === 1 && index < 10 ? "fw-enter" : undefined}
                  style={
                    page === 1 && index < 10 ? { animationDelay: `${index * 50}ms` } : undefined
                  }
                >
                  <FeedCard item={item} forumName={feedForumName(item.forumId)} />
                </div>
              ))}
            </div>
          )}

          {/* 分页：加载更多（D2：追加式留 S5 增强，先以偏移翻页闭环） */}
          <div className="flex items-center justify-center gap-4 py-2 text-sm">
            {page > 1 && (
              <Link
                href={feedHref({ page: page - 1 })}
                className="text-muted-foreground hover:text-primary"
              >
                ← 上一页
              </Link>
            )}
            {feed.hasMore ? (
              <Link
                href={feedHref({ page: page + 1 })}
                className="rounded-lg border px-4 py-2 transition-colors hover:bg-accent"
              >
                加载更多
              </Link>
            ) : (
              feed.items.length > 0 && (
                <span className="text-muted-foreground">已加载全部 {feed.items.length} 条</span>
              )
            )}
          </div>
        </div>

        {/* 右栏（xl）：品牌 + 模块槽位（签到卡）+ 热帖 + 统计 + 热门版块 */}
        <aside className="hidden space-y-4 self-start xl:sticky xl:top-24 xl:block">
          <BrandCard logoUrl={chrome.logoActive ? "/brand/logo" : null} />
          <Slot name="home.rail" />
          <section className="rounded-xl border bg-card p-4">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Flame className="size-4 text-primary" aria-hidden /> 本站热帖
            </h2>
            <ul className="mt-2">
              {hot.map((t, i) => (
                <li
                  key={t.id}
                  className="flex gap-2 border-b border-dashed py-2 text-[13px] last:border-b-0"
                >
                  <span className="w-4 shrink-0 text-xs text-muted-foreground">{i + 1}</span>
                  <Link
                    href={`/t/${t.id}`}
                    className="min-w-0 flex-1 truncate text-muted-foreground hover:text-primary"
                  >
                    {t.title}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">{t.replyCount}</span>
                </li>
              ))}
              {hot.length === 0 && <li className="py-2 text-xs text-muted-foreground">暂无</li>}
            </ul>
          </section>

          <section className="rounded-xl border bg-card p-4">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Layers className="size-4 text-primary" aria-hidden /> 社区统计
            </h2>
            <p className="mt-2 text-[13px] leading-7 text-muted-foreground">
              版块 {dir.forumCount} · 主题 {dir.threadCount}
            </p>
          </section>

          <section className="rounded-xl border bg-card p-4">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Home className="size-4 text-primary" aria-hidden /> 热门版块
            </h2>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {topForums.map((f) => (
                <Link
                  key={f.id}
                  href={`/f/${f.id}`}
                  className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                >
                  {f.name}
                </Link>
              ))}
            </div>
          </section>

          {isDevEnv() && (
            <Link
              href="/design"
              className="block text-center text-xs text-muted-foreground hover:text-primary"
            >
              设计系统（内部）
            </Link>
          )}
        </aside>
      </div>

      <Slot name="home.footer-notice" />
    </main>
  );
}
