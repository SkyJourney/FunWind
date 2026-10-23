import type { EventName } from "./types";

/** 事件名运行时清单（dev API 校验用；与 EventPayloads 键保持一致） */
export const EVENT_NAMES = [
  "user.logged_in",
  "user.registered",
  "thread.created",
  "thread.replied",
  "thread.edited",
  "thread.deleted",
  "attachment.uploaded",
  "credit.changed",
  "medal.awarded",
  "checkin.done",
] as const satisfies readonly EventName[];

export function isEventName(v: unknown): v is EventName {
  return typeof v === "string" && (EVENT_NAMES as readonly string[]).includes(v);
}

/** 各事件 payload 的必填键（外部入口——如 dev emit API——的运行时校验依据） */
export const REQUIRED_PAYLOAD_KEYS: Record<EventName, readonly string[]> = {
  "user.logged_in": ["userId"],
  "user.registered": ["userId"],
  "thread.created": ["threadId", "forumId", "authorId"],
  "thread.replied": ["threadId", "postId", "authorId"],
  "thread.edited": ["threadId", "editorId"],
  "thread.deleted": ["threadId", "operatorId"],
  "attachment.uploaded": ["attachmentId", "uploaderId"],
  "credit.changed": ["userId", "creditType", "delta"],
  "medal.awarded": ["userId", "medalId"],
  "checkin.done": ["userId"],
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
