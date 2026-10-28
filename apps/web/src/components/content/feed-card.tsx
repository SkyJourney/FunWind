import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { ThreadBadges } from "@/components/content/thread-row";
import type { HomeFeedItem } from "@/lib/queries/threads";

/**
 * 首页内容流卡片（M10.5 S5，D1 列表流定稿）：左文右图；
 * 版块徽标可点（进版块），标题可点（进主题）；无图帖自动收缩为纯文本卡。
 */
export function FeedCard({ item, forumName }: { item: HomeFeedItem; forumName?: string }) {
  const author = item.authorDeleted || !item.authorName ? "已注销" : item.authorName;
  return (
    <article className="flex gap-4 rounded-xl border bg-card p-4 shadow-1 transition-shadow duration-fast hover:shadow-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {forumName && (
            <Link
              href={`/f/${item.forumId}`}
              className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-primary"
            >
              {forumName}
            </Link>
          )}
          {item.prefixName && <span className="text-primary">[{item.prefixName}]</span>}
          <ThreadBadges thread={item} />
        </div>
        <h3 className="mt-1.5 text-[15.5px] leading-snug font-semibold [overflow-wrap:anywhere]">
          <Link href={`/t/${item.id}`} className="hover:text-primary hover:underline">
            {item.title}
          </Link>
        </h3>
        {item.excerpt && (
          <p className="mt-1 line-clamp-2 text-[13px] [overflow-wrap:anywhere] text-muted-foreground">
            {item.excerpt}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{author}</span>
          {item.lastPostedAt && <span>{item.lastPostedAt}</span>}
          <span className="inline-flex items-center gap-1" title="回复">
            <MessageSquare className="size-3" aria-hidden />
            {item.replyCount}
          </span>
        </div>
      </div>
      {item.coverUrl && (
        <Link
          href={`/t/${item.id}`}
          className="hidden w-28 shrink-0 sm:block"
          tabIndex={-1}
          aria-hidden
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- 内容图与正文管线同口径（/files 与旧站外链），不走 next/image 优化域 */}
          <img
            src={item.coverUrl}
            alt=""
            loading="lazy"
            className="aspect-[16/10] w-full rounded-lg border object-cover"
          />
        </Link>
      )}
    </article>
  );
}
