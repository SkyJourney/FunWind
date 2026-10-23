import Link from "next/link";
import { FlaskConical, Paperclip, Star, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ThreadListItem } from "@/lib/queries/threads";

/** 徽标组：置顶（三级）/精华（两级）/投票/附件 */
export function ThreadBadges({ thread }: { thread: ThreadListItem }) {
  const badges: { label: string; cls: string; icon: React.ReactNode }[] = [];
  if (thread.topped >= 3)
    badges.push({
      label: "全站置顶",
      cls: "bg-destructive/10 text-destructive border-destructive/30",
      icon: <Trophy className="size-3" />,
    });
  else if (thread.topped >= 1)
    badges.push({
      label: "置顶",
      cls: "bg-warning/10 text-warning border-warning/30",
      icon: <Trophy className="size-3" />,
    });
  if (thread.digest > 0)
    badges.push({
      label: "精华",
      cls: "bg-primary/10 text-primary border-primary/30",
      icon: <Star className="size-3" />,
    });
  if (thread.special === "poll")
    badges.push({
      label: "投票",
      cls: "bg-info/10 text-info border-info/30",
      icon: <FlaskConical className="size-3" />,
    });
  if (thread.attachCount > 0)
    badges.push({
      label: "附件",
      cls: "bg-muted text-muted-foreground border-border",
      icon: <Paperclip className="size-3" />,
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
    <div className="flex items-center gap-3 border-b py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <ThreadBadges thread={thread} />
          <Link
            href={`/t/${thread.id}`}
            className="truncate font-medium hover:text-primary hover:underline"
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
          <span>{thread.authorName ?? "已注销"}</span>
          {thread.lastPostAt && <span>{thread.lastPostAt}</span>}
        </div>
      </div>
      <div className="flex shrink-0 gap-4 text-xs text-muted-foreground">
        <span title="回帖">{thread.replyCount}</span>
        <span title="浏览">{thread.viewCount}</span>
      </div>
    </div>
  );
}
