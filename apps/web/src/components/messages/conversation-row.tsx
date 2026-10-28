import Link from "next/link";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import type { ConversationItem } from "@/lib/pm/queries";

/**
 * 私信会话行（/messages）：服务端渲染的首屏与客户端追加项共用同一份版式。
 * 未读数与预览是请求时刻的快照；本组件只展示，不含任何读写逻辑。
 */
export function ConversationRow({
  conversation: c,
  className,
  style,
}: {
  conversation: ConversationItem;
  /** 附加到根元素的类（首屏错落进场 / 追加项淡入） */
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <li className={className} style={style}>
      <Link
        href={`/messages/${c.conversationId}`}
        className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-accent/40"
      >
        <Avatar size="default">
          <AvatarFallback>{(c.otherName ?? "?").slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-semibold">
              {c.otherDeleted ? "已注销用户" : (c.otherName ?? "未知用户")}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{c.lastMessageAt ?? ""}</span>
          </p>
          <p className="truncate text-[13px] text-muted-foreground">
            {c.preview ? `${c.preview.senderIsSelf ? "我：" : ""}${c.preview.body}` : "还没有消息"}
          </p>
        </div>
        {c.unread > 0 && (
          <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
            {c.unread}
          </span>
        )}
      </Link>
    </li>
  );
}
