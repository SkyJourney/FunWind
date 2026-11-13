/**
 * Web Push 域公共类型（M18，零依赖双栖：服务端投递与客户端订阅流程共用）。
 *
 * 推送首期只做场景通知（notice），镜像邮件渠道的「尽力而为 + 审计日志」模式。
 * 隐私口径：payload 只含标题/正文/跳转 URL，**不存正文到 push_log**（照 email_log 先例）。
 */

/** 推送类别；首期仅场景通知（post.replied / post.mentioned / pm.received 三类） */
export type PushKind = "notice";

/** 一条可发送的推送：标题 + 正文 + 点击跳转；kind/scene 随推送进入发送记录 */
export interface PushMessage {
  kind: PushKind;
  /** 场景标识 = 通知类型 id，如 pm-received、post-replied */
  scene: string;
  title: string;
  body: string;
  /** 点击通知后聚焦/打开的目标 URL（站内绝对路径） */
  url: string;
}

/** 浏览器 PushManager.subscribe 产出的订阅凭据（落 push_subscriptions） */
export interface PushSubscriptionKeys {
  endpoint: string;
  /** 客户端公钥（P-256 DH，base64url） */
  p256dh: string;
  /** 客户端认证密钥（base64url） */
  auth: string;
}
