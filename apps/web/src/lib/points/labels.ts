/** 渠道显示名（台账/管理页共用）。模块未来可自带 label——显示名收口在此，避免各页漂移 */
export const POINT_CHANNEL_LABELS: Record<string, string> = {
  opening: "期初余额",
  "spend.gate_unlock": "解锁内容",
  "earn.gate_sale": "内容收益",
  "earn.post": "发帖奖励",
  "earn.reply": "回帖奖励",
  "earn.checkin": "签到奖励",
  "adjust.admin": "管理员调整",
};

export const channelLabel = (channel: string): string => POINT_CHANNEL_LABELS[channel] ?? channel;
