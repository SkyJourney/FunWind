/**
 * Web Push 域统一出口（M18）：类型、发送与记录、通知渠道偏好/开关/频控。
 * 业务代码只从这里导入；web-push 与 push_log 的细节封在 transport.ts。
 */
export type { PushKind, PushMessage, PushSubscriptionKeys } from "./types";
export { sendPush, trySendPush, type PushSendMeta } from "./transport";
export {
  pushEnabled,
  userPushEnabled,
  sendUserPush,
  pmPushAllowed,
  userActiveRecently,
} from "./notify";
