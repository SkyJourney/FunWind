import type { NotificationCategory } from "@/modules/kernel/types";

/**
 * 通知类型目录与渲染模板（M8，docs/NOTIFICATIONS.md §4）。
 * 单一事实源：模块注册的 notificationTypes 与本表一一对应（注册校验 key/category/aggregate/mandatory，
 * 本表补文案；两处不同步会被 notify 的类型解析测试抓出）。
 *
 * 文案占位符：{actor}=触发者名（读取层 join），{count}=聚合数，其余来自 data 快照。
 * 渲染不做富文本，全部纯文本（面板/页面通用）。
 */

export interface NotificationTypeSpec {
  key: string;
  category: NotificationCategory;
  aggregate: boolean;
  mandatory: boolean;
  /** 面板/列表渲染模板 */
  template: string;
}

export const NOTIFICATION_TYPE_SPECS: NotificationTypeSpec[] = [
  // ---- 互动 ----
  {
    key: "post.replied",
    category: "interaction",
    aggregate: true,
    mandatory: false,
    template: "{actor} 回复了你的主题《{title}》",
  },
  {
    key: "post.reply_to",
    category: "interaction",
    aggregate: true,
    mandatory: false,
    template: "{actor} 回复了你的第 {floor} 楼",
  },
  {
    key: "post.mentioned",
    category: "interaction",
    aggregate: false,
    mandatory: false,
    template: "{actor} 在主题中提到了你",
  },
  {
    key: "post.liked",
    category: "interaction",
    aggregate: true,
    mandatory: false,
    template: "{actor} 赞了你的帖子",
  },
  {
    key: "user.followed",
    category: "interaction",
    aggregate: true,
    mandatory: false,
    template: "{actor} 关注了你",
  },
  {
    key: "gate.sold",
    category: "interaction",
    aggregate: true,
    mandatory: false,
    template: "{actor} 购买了你的付费内容（+{price}）",
  },
  // ---- 私信（M10 接线）----
  {
    key: "pm.received",
    category: "message",
    aggregate: true,
    mandatory: false,
    template: "{actor} 发来私信",
  },
  // ---- 审核与管理（mandatory；M9 接线）----
  {
    key: "review.pending",
    category: "moderation",
    aggregate: true,
    mandatory: true,
    template: "你所辖版块有 {count} 条内容待审",
  },
  {
    key: "content.submitted",
    category: "moderation",
    aggregate: false,
    mandatory: true,
    template: "你的内容已提交，正在等待审核",
  },
  {
    key: "content.approved",
    category: "moderation",
    aggregate: false,
    mandatory: true,
    template: "你提交的内容已通过审核",
  },
  {
    key: "content.rejected",
    category: "moderation",
    aggregate: false,
    mandatory: true,
    template: "你提交的内容未通过审核：{reason}",
  },
  {
    key: "content.removed",
    category: "moderation",
    aggregate: false,
    mandatory: true,
    template: "你的内容被版主删除：{reason}",
  },
  {
    key: "content.hidden",
    category: "moderation",
    aggregate: false,
    mandatory: true,
    template: "你的内容被版主屏蔽：{reason}",
  },
  {
    key: "content.restored",
    category: "moderation",
    aggregate: false,
    mandatory: true,
    template: "你的内容被版主恢复",
  },
  {
    key: "thread.locked",
    category: "moderation",
    aggregate: false,
    mandatory: true,
    template: "你的主题被关闭",
  },
  {
    key: "thread.unlocked",
    category: "moderation",
    aggregate: false,
    mandatory: true,
    template: "你的主题被重新开启",
  },
  {
    key: "thread.moved",
    category: "moderation",
    aggregate: false,
    mandatory: true,
    template: "你的主题被移动到其它版块",
  },
  {
    key: "thread.featured",
    category: "moderation",
    aggregate: false,
    mandatory: false,
    template: "你的主题被加精",
  },
  {
    key: "thread.pinned",
    category: "moderation",
    aggregate: false,
    mandatory: false,
    template: "你的主题被置顶",
  },
  {
    key: "account.restricted",
    category: "moderation",
    aggregate: false,
    mandatory: true,
    template: "你的账号被限制：{reason}",
  },
  {
    key: "account.restriction_lifted",
    category: "moderation",
    aggregate: false,
    mandatory: true,
    template: "对你的账号限制已解除",
  },
  {
    key: "account.role_changed",
    category: "moderation",
    aggregate: false,
    mandatory: true,
    template: "你的角色发生了变化",
  },
  {
    key: "report.resolved",
    category: "moderation",
    aggregate: false,
    mandatory: false,
    template: "你的举报已处理：{note}",
  },
  // ---- 账号与安全 ----
  {
    key: "security.password_changed",
    category: "account",
    aggregate: false,
    mandatory: true,
    template: "你的密码被修改或重置（不是你操作？请立即找回）",
  },
  {
    key: "points.adjusted",
    category: "account",
    aggregate: false,
    mandatory: true,
    template: "管理员调整了你的积分（{delta}）",
  },
  {
    key: "badge.awarded",
    category: "account",
    aggregate: false,
    mandatory: false,
    template: "你获得了新徽章",
  },
  {
    key: "system.welcome",
    category: "account",
    aggregate: false,
    mandatory: false,
    template: "欢迎来到青翼字幕组",
  },
  {
    key: "system.claim_reminder",
    category: "account",
    aggregate: false,
    mandatory: false,
    template: "你的老账号可以认领了",
  },
];

const SPEC_BY_KEY = new Map(NOTIFICATION_TYPE_SPECS.map((s) => [s.key, s]));

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  interaction: "互动",
  message: "私信",
  moderation: "审核与管理",
  account: "账号与安全",
};

/** 类型规格（未注册的 key 返回 null——调用方自行决定告警或跳过） */
export function typeSpec(key: string): NotificationTypeSpec | null {
  return SPEC_BY_KEY.get(key) ?? null;
}

/** 渲染文案：模板占位符替换（data 缺失的占位符保留原样，便于发现数据缺口） */
export function renderNotification(
  key: string,
  data: Record<string, unknown> | null,
  actorName?: string | null,
): { label: string; categoryLabel: string } | null {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) return null;
  const d = data ?? {};
  let text = spec.template;
  if (actorName) text = text.replaceAll("{actor}", actorName);
  for (const [k, v] of Object.entries(d)) {
    if (v !== undefined && v !== null) text = text.replaceAll(`{${k}}`, String(v));
  }
  return { label: text, categoryLabel: CATEGORY_LABELS[spec.category] };
}
