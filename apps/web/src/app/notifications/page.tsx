import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listFeed, unreadSummary, type FeedCategory } from "@/lib/notifications/queries";
import { renderNotification } from "@/lib/notifications/render";
import { markAllReadAction, markOneReadAction } from "@/app/actions/notifications";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "通知" };

const CATEGORY_TABS: { key: FeedCategory | undefined; label: string }[] = [
  { key: undefined, label: "全部" },
  { key: "interaction", label: "互动" },
  { key: "message", label: "私信" },
  { key: "moderation", label: "审核与管理" },
  { key: "account", label: "账号与安全" },
  { key: "announcement", label: "公告" },
];

/**
 * 精简通知页（M8 站长拍板 1）：合并时间线 + 游标分页 + 点击已读。
 * 分类 Tab / 批量操作 / 偏好设置归后续完整页。
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; before?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const sp = await searchParams;
  const cat = CATEGORY_TABS.some((t) => t.key === sp.cat) ? (sp.cat as FeedCategory) : undefined;
  const before = typeof sp.before === "string" && sp.before ? sp.before : undefined;

  const [summary, feed] = await Promise.all([
    unreadSummary(user.id),
    listFeed(user.id, { category: cat, before }),
  ]);
  const unreadIds = new Set(feed.items.filter((i) => !i.read).map((i) => `${i.kind}:${i.id}`));

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">通知</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-xs text-muted-foreground">未读 {summary.total}</span>
          {summary.total > 0 && (
            <form action={markAllReadAction}>
              <input
                type="hidden"
                name="back"
                value={cat ? `/notifications?cat=${cat}` : "/notifications"}
              />
              <button type="submit" className="text-primary hover:underline">
                全部已读
              </button>
            </form>
          )}
        </div>
      </header>

      <nav className="flex flex-wrap gap-1.5" aria-label="通知分类">
        {CATEGORY_TABS.map((t) => {
          const href = t.key ? `/notifications?cat=${t.key}` : "/notifications";
          const active = cat === t.key;
          const unread = t.key ? summary[t.key as keyof typeof summary] : summary.total;
          return (
            <Link
              key={t.label}
              href={href}
              className={`rounded-full border px-3 py-1 text-xs ${active ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {t.label}
              {unread > 0 && (
                <span className={active ? "opacity-80" : "text-primary"}> {unread}</span>
              )}
            </Link>
          );
        })}
      </nav>

      {feed.items.length === 0 ? (
        <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          {before ? "没有更早的通知了。" : "暂无通知。互动、系统消息与公告都会出现在这里。"}
        </p>
      ) : (
        <ul className="space-y-2">
          {feed.items.map((item) => {
            const rendered =
              item.kind === "announcement"
                ? { label: `公告：${item.title ?? ""}`, categoryLabel: "公告" }
                : renderNotification(item.type, item.data, item.actorName);
            const unread = unreadIds.has(`${item.kind}:${item.id}`);
            return (
              <li
                key={`${item.kind}:${item.id}`}
                className={`rounded-xl border bg-card px-4 py-3 ${unread ? "" : "opacity-70"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">
                      {rendered?.categoryLabel ?? item.category} · {item.createdAt}
                    </p>
                    <p className={`mt-0.5 text-sm ${unread ? "font-medium" : ""}`}>
                      {rendered?.label ?? item.type}
                      {item.kind === "notification" &&
                        item.groupKey !== null &&
                        ((item.data as { count?: number } | null)?.count ?? 0) > 1 && (
                          <span className="ml-1 text-xs text-primary">
                            （{(item.data as { count: number }).count} 条）
                          </span>
                        )}
                    </p>
                    {item.kind === "announcement" && item.bodyMd && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {item.bodyMd}
                      </p>
                    )}
                  </div>
                  {unread && (
                    <form action={markOneReadAction} className="shrink-0">
                      <input type="hidden" name="kind" value={item.kind} />
                      <input type="hidden" name="id" value={item.id} />
                      <input
                        type="hidden"
                        name="back"
                        value={cat ? `/notifications?cat=${cat}` : "/notifications"}
                      />
                      <button type="submit" className="text-xs text-primary hover:underline">
                        {item.kind === "announcement" ? "标记所有公告已读" : "已读"}
                      </button>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center justify-between text-sm">
        {feed.nextCursor ? (
          <Link
            href={`/notifications?${cat ? `cat=${cat}&` : ""}before=${encodeURIComponent(feed.nextCursor)}`}
            className="text-primary hover:underline"
          >
            更早的通知 →
          </Link>
        ) : (
          <span />
        )}
        <Link href="/" className="text-muted-foreground hover:text-primary">
          ← 返回首页
        </Link>
      </div>
    </main>
  );
}
