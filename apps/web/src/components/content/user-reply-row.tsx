import Link from "next/link";
import type { UserReplyItem } from "@/lib/queries/users";

/**
 * 用户公开回复行（用户主页「回复」tab）：服务端渲染的首屏与客户端追加项共用同一份版式。
 * 摘要只来自公开口径查询（getUserReplies），本组件不做任何可见性判断。
 */
export function UserReplyRow({
  reply,
  className,
  style,
}: {
  reply: UserReplyItem;
  /** 附加到根元素的类（首屏错落进场 / 追加项淡入） */
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`px-4 py-3${className ? ` ${className}` : ""}`} style={style}>
      <p className="text-[13px] text-muted-foreground">
        回复了
        <Link href={`/p/${reply.postId}`} className="mx-1 text-foreground hover:text-primary">
          『{reply.threadTitle}』
        </Link>
        <span className="ml-1">#{reply.floor}</span>
      </p>
      {reply.excerpt && <p className="mt-1 line-clamp-2 text-sm">{reply.excerpt}</p>}
      <p className="mt-1 text-xs text-muted-foreground">{reply.createdAt}</p>
    </div>
  );
}
