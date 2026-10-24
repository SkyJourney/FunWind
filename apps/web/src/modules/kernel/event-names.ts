import type { EventName } from "./types";

/** 事件名运行时清单（dev API 校验用；与 EventPayloads 键保持一致） */
export const EVENT_NAMES = [
  "user.logged_in",
  "user.registered",
  "user.followed",
  "thread.created",
  "thread.replied",
  "thread.edited",
  "post.edited",
  "thread.deleted",
  "post.deleted",
  "thread.moderated",
  "content.submitted",
  "content.moderated",
  "post.mentioned",
  "reaction.added",
  "message.sent",
  "attachment.uploaded",
  "restriction.changed",
  "role.changed",
  "announcement.published",
  "points.changed",
  "gate.unlocked",
  "badge.awarded",
  "checkin.done",
] as const satisfies readonly EventName[];

export function isEventName(v: unknown): v is EventName {
  return typeof v === "string" && (EVENT_NAMES as readonly string[]).includes(v);
}

/** 各事件 payload 的必填键（外部入口——如 dev emit API——的运行时校验依据） */
export const REQUIRED_PAYLOAD_KEYS: Record<EventName, readonly string[]> = {
  "user.logged_in": ["userId"],
  "user.registered": ["userId"],
  "user.followed": ["userId", "targetType", "targetId"],
  "thread.created": ["threadId", "postId", "forumId", "authorId", "title"],
  "thread.replied": ["threadId", "postId", "forumId", "authorId", "threadAuthorId"],
  "thread.edited": ["threadId", "postId", "forumId", "authorId", "editorId", "title"],
  "post.edited": ["postId", "threadId", "forumId", "authorId", "editorId"],
  "thread.deleted": ["threadId", "postId", "forumId", "authorId", "operatorId", "byModerator"],
  "post.deleted": ["postId", "threadId", "forumId", "authorId", "operatorId", "byModerator"],
  "thread.moderated": ["threadId", "operatorId", "action"],
  "content.submitted": ["postId", "threadId", "authorId", "forumId", "isThread"],
  "content.moderated": ["postId", "operatorId", "action"],
  "post.mentioned": ["postId", "authorId", "mentionedUserId"],
  "reaction.added": ["userId", "postId", "kind"],
  "message.sent": ["conversationId", "messageId", "senderId", "recipientId"],
  "attachment.uploaded": ["attachmentId", "fileId", "uploaderId"],
  "restriction.changed": ["userId", "kind", "action", "operatorId"],
  "role.changed": ["userId", "roleKey", "scopeId", "action", "operatorId"],
  "announcement.published": ["announcementId", "createdBy"],
  "points.changed": ["userId", "channel", "delta"],
  "gate.unlocked": ["gateId", "userId", "authorId", "price"],
  "badge.awarded": ["userId", "badgeId"],
  "checkin.done": ["userId", "streak"],
};

/** 校验 payload 必填键；返回错误描述或 null（合法） */
export function validateEventPayload(name: EventName, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "payload 必须是对象";
  }
  const record = payload as Record<string, unknown>;
  const missing = REQUIRED_PAYLOAD_KEYS[name].filter((k) => record[k] === undefined);
  return missing.length > 0 ? `payload 缺少字段: ${missing.join(", ")}` : null;
}
