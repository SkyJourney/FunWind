import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listFeed, unreadSummary, type FeedCategory } from "@/lib/notifications/queries";
import { toNotificationRow } from "@/lib/notifications/row";
import { NotificationRow } from "@/components/notifications/notification-row";
import { NotificationStream } from "@/components/notifications/notification-stream";
import { markAllReadAction } from "@/app/actions/notifications";
import { EmptyState } from "@/components/empty-state";
import { BellOff } from "lucide-react";

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
  const rows = feed.items.map(toNotificationRow);
  const backHref = cat ? `/notifications?cat=${cat}` : "/notifications";
  /** 流式追加的取数地址：带分类（游标由组件追加） */
  const streamEndpoint = `/api/stream/notifications${cat ? `?cat=${cat}` : ""}`;

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">通知</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-xs text-muted-foreground">未读 {summary.total}</span>
          {summary.total > 0 && (
            <form action={markAllReadAction}>
              <input type="hidden" name="back" value={backHref} />
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
        <EmptyState
          icon={BellOff}
          title={before ? "没有更早的通知了" : "这里很安静"}
          description={before ? undefined : "互动、系统消息与公告都会出现在这里"}
        />
      ) : (
        // M10.7 Step 3b：首屏服务端渲染（无游标时前 10 条错落进场），更早的通知触底追加；
        // 无 JS 时底部「加载更多」是指向下一段（?before=）的真链接
        <NotificationStream
          endpoint={streamEndpoint}
          fallbackHref={backHref}
          startCursor={feed.nextCursor}
          seedKeys={rows.map((r) => r.key)}
          backHref={backHref}
        >
          {rows.map((row, index) => (
            <NotificationRow
              key={row.key}
              row={row}
              backHref={backHref}
              className={!before && index < 10 ? "fw-enter" : undefined}
              style={!before && index < 10 ? { animationDelay: `${index * 50}ms` } : undefined}
            />
          ))}
        </NotificationStream>
      )}

      <div className="flex items-center justify-end text-sm">
        <Link href="/" className="text-muted-foreground hover:text-primary">
          ← 返回首页
        </Link>
      </div>
    </main>
  );
}
