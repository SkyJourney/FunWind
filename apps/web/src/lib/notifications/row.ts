import type { FeedItem } from "./queries";
import { renderNotification } from "./render";

/**
 * 通知页的行数据（M10.7 Step 3b）：在服务端把一条 FeedItem 预渲染成纯数据。
 * 首屏（页面）与追加页（/api/stream/notifications）走同一个函数，两处展示因此完全一致；
 * 文案模板与原始 data 载荷也不会下发到客户端（客户端组件只拿到渲染好的文字）。
 */
export interface NotificationRowData {
  /** 流内唯一键：通知与公告各有自己的 id 序列，必须带 kind */
  key: string;
  id: number;
  kind: "notification" | "announcement";
  read: boolean;
  createdAt: string;
  categoryLabel: string;
  label: string;
  /** 私信类通知的会话 id（行文案可点击进入会话） */
  conversationId: number | null;
  /** 聚合通知的条数（>1 才有） */
  groupCount: number | null;
  /** 公告正文（列表只显示两行摘要） */
  bodyMd: string | null;
}

export function toNotificationRow(item: FeedItem): NotificationRowData {
  const rendered =
    item.kind === "announcement"
      ? { label: `公告：${item.title ?? ""}`, categoryLabel: "公告" }
      : renderNotification(item.type, item.data, item.actorName);
  const count = (item.data as { count?: number } | null)?.count ?? 0;
  return {
    key: `${item.kind}:${item.id}`,
    id: item.id,
    kind: item.kind,
    read: item.read,
    createdAt: item.createdAt,
    categoryLabel: rendered?.categoryLabel ?? item.category,
    label: rendered?.label ?? item.type,
    conversationId:
      item.targetType === "conversation" && item.targetId !== undefined ? item.targetId : null,
    groupCount: item.kind === "notification" && item.groupKey !== null && count > 1 ? count : null,
    bodyMd: item.kind === "announcement" ? (item.bodyMd ?? null) : null,
  };
}
