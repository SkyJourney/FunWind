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
