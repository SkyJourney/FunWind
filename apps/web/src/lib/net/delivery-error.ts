const failures = {
  smtpRejected: { outcome: "failed", message: "SMTP 服务明确拒绝投递" },
  smtpUncertain: { outcome: "uncertain", message: "SMTP 投递结果未知" },
  pushRejected: { outcome: "failed", message: "推送服务明确拒绝投递" },
  pushUncertain: { outcome: "uncertain", message: "推送投递结果未知" },
  pushVapidMissing: { outcome: "failed", message: "VAPID 密钥未配置，跳过推送" },
  pushVapidInvalid: { outcome: "failed", message: "VAPID 配置无效，跳过推送" },
  pushSubscriptionChanged: { outcome: "failed", message: "设备订阅已变更，跳过推送" },
} as const;

/** 仅携带固定文案和投递结果，不保留底层错误；只有明确未接纳才允许重投。 */
export class DeliveryTransportError extends Error {
  readonly outcome: "failed" | "uncertain";

  constructor(failure: keyof typeof failures) {
    const { message, outcome } = failures[failure];
    super(message);
    this.name = "DeliveryTransportError";
    this.outcome = outcome;
  }
}
