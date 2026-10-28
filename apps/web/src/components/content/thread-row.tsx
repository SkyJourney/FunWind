import Link from "next/link";
import { Clock, FlaskConical, Lock, Star, Trophy, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ThreadListItem } from "@/lib/queries/threads";

/** 徽标组：置顶（三档）/精华/投票/锁定/审核状态（仅作者本人与版主会看到非公开状态的主题） */
export function ThreadBadges({ thread }: { thread: ThreadListItem }) {
  const badges: { label: string; cls: string; icon: React.ReactNode }[] = [];
  if (thread.state === "pending")
    badges.push({
      label: "审核中",
      cls: "bg-info/10 text-info border-info/30",
      icon: <Clock className="size-3" />,
    });
  if (thread.state === "rejected")
    badges.push({
      label: "已驳回",
      cls: "bg-destructive/10 text-destructive border-destructive/30",
      icon: <XCircle className="size-3" />,
    });
  if (thread.state === "hidden" || thread.state === "deleted")
    badges.push({
      label: thread.state === "hidden" ? "已隐藏" : "已删除",
      cls: "bg-muted text-muted-foreground border-border",
      icon: <XCircle className="size-3" />,
    });
  if (thread.pinLevel >= 3)
    badges.push({
      label: "全站置顶",
      cls: "bg-destructive/10 text-destructive border-destructive/30",
      icon: <Trophy className="size-3" />,
    });
  else if (thread.pinLevel === 2)
    badges.push({
      label: "分区置顶",
      cls: "bg-warning/10 text-warning border-warning/30",
      icon: <Trophy className="size-3" />,
    });
  else if (thread.pinLevel === 1)
    badges.push({
      label: "置顶",
      cls: "bg-warning/10 text-warning border-warning/30",
      icon: <Trophy className="size-3" />,
    });
  if (thread.isFeatured)
    badges.push({
      label: "精华",
      cls: "bg-primary/10 text-primary border-primary/30",
      icon: <Star className="size-3" />,
    });
  if (thread.kind === "poll")
    badges.push({
      label: "投票",
      cls: "bg-info/10 text-info border-info/30",
      icon: <FlaskConical className="size-3" />,
    });
  if (thread.isLocked)
    badges.push({
      label: "已锁定",
      cls: "bg-muted text-muted-foreground border-border",
      icon: <Lock className="size-3" />,
    });
  return (
    <>
      {badges.map((b) => (
        <Badge key={b.label} variant="outline" className={`gap-0.5 px-1.5 py-0 ${b.cls}`}>
          {b.icon}
          {b.label}
        </Badge>
      ))}
    </>
  );
}

export function ThreadRow({
  thread,
  showForum = false,
  forumName,
}: {
  thread: ThreadListItem;
  showForum?: boolean;
  forumName?: string;
}) {
  return (
    // 水平 padding 内建（M10.6d 站长反馈：卡片内文字不得贴边框——PC/移动同构，使用方无需各自覆写）
    <div className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <ThreadBadges thread={thread} />
          {thread.prefixName && (
            <span className="shrink-0 text-xs text-primary">[{thread.prefixName}]</span>
          )}
          <Link
            href={`/t/${thread.id}`}
            className="truncate font-medium [overflow-wrap:anywhere] hover:text-primary hover:underline"
          >
            {thread.title}
          </Link>
          {showForum && forumName && (
            <Link
              href={`/f/${thread.forumId}`}
              className="shrink-0 text-xs text-muted-foreground hover:text-primary"
            >
              {forumName}
            </Link>
          )}
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
          <span>{thread.authorDeleted || !thread.authorName ? "已注销" : thread.authorName}</span>
          {thread.lastPostedAt && <span>{thread.lastPostedAt}</span>}
        </div>
      </div>
      <div className="flex shrink-0 gap-4 text-xs text-muted-foreground">
        <span title="回帖">{thread.replyCount}</span>
        <span title="浏览">{thread.viewCount}</span>
      </div>
    </div>
  );
}
