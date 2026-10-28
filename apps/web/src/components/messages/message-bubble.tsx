import type { ChatMessage } from "@/lib/pm/queries";

/**
 * 聊天气泡（对话页）：服务端渲染的最新一批与客户端上滑加载的更早消息共用同一份版式。
 * `mine` 决定左右与配色；纯展示，无任何读写逻辑。
 */
export function MessageBubble({ message, mine }: { message: ChatMessage; mine: boolean }) {
  return (
    <li className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
          mine ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm border bg-card"
        }`}
      >
        <p className="break-words whitespace-pre-wrap">{message.body}</p>
        <p className={`mt-0.5 text-[10px] ${mine ? "opacity-70" : "text-muted-foreground"}`}>
          {message.createdAt}
        </p>
      </div>
    </li>
  );
}
