/**
 * 通知偏好可选类型（M10.6c，docs/NOTIFICATIONS.md §4 的用户侧子集）：
 * 版主工作流（review.pending）与账户强制类不开放关闭；channel 仅站内（邮件/推送未实现）。
 * 默认全开：notification_preferences 无行 = 开启（inAppEnabled 口径）。
 */
export interface NotifPrefType {
  type: string;
  label: string;
  description: string;
}

export const NOTIF_PREF_TYPES: NotifPrefType[] = [
  { type: "post.replied", label: "主题被回复", description: "有人回复了你发布的主题" },
  { type: "post.reply_to", label: "楼层被回复", description: "有人回复了你的某一楼" },
  { type: "post.mentioned", label: "被 @ 提及", description: "有人在帖子中 @ 了你" },
  { type: "post.liked", label: "帖子被赞", description: "你的帖子收到了点赞" },
  { type: "user.followed", label: "新关注者", description: "有人关注了你" },
  { type: "gate.sold", label: "内容被购买", description: "你的付费内容被购买（含收益）" },
  { type: "pm.received", label: "收到私信", description: "有人给你发私信" },
  { type: "content.submitted", label: "内容进入审核", description: "你发布的内容进入待审核" },
  { type: "content.approved", label: "审核通过", description: "你提交的内容审核通过并发布" },
];
