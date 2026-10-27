import type { MySqlTable } from "drizzle-orm/mysql-core";
import type { ReactNode } from "react";

/**
 * 模块内核契约（M2 定稿）。
 * 扩展事件/槽位清单 = 修改本文件并在 docs/MODULES.md 说明——模块不得私设插入点。
 */

// ---------- 事件清单（24 个，docs/MODULES.md 定稿；命名承接旧 phpwind 钩子语义；M6.1 新增 post.edited / post.deleted） ----------
// 派发状态：user.logged_in / user.registered / role.changed / points.changed / gate.unlocked 已有真实派发者（M5.5 S4-5），
// 其余为契约，由各自里程碑（M6 发帖、M8 互动、M9 后台、M10 私信…）接线。
export interface EventPayloads {
  "user.logged_in": { userId: number };
  "user.registered": { userId: number };
  "user.followed": { userId: number; targetType: "user" | "forum"; targetId: number };
  /** 载荷只放 id 与标题，绝不放正文（event_log 会持久化；M6.1 设计稿 §7.2） */
  "thread.created": {
    threadId: number;
    postId: number;
    forumId: number;
    authorId: number;
    title: string;
  };
  "thread.replied": {
    threadId: number;
    postId: number;
    forumId: number;
    authorId: number;
    /** 主题作者（M8 通知给楼主） */
    threadAuthorId: number;
    replyToPostId?: number;
    replyToAuthorId?: number;
  };
  /** 首帖 / 标题被编辑（回帖编辑用 post.edited） */
  "thread.edited": {
    threadId: number;
    postId: number;
    forumId: number;
    authorId: number;
    editorId: number;
    title: string;
  };
  "post.edited": {
    postId: number;
    threadId: number;
    forumId: number;
    authorId: number;
    editorId: number;
  };
  /** 主题被软删；byModerator 表示是否由版主操作（理由在 audit_log，不进事件） */
  "thread.deleted": {
    threadId: number;
    postId: number;
    forumId: number;
    authorId: number;
    operatorId: number;
    byModerator: boolean;
  };
  "post.deleted": {
    postId: number;
    threadId: number;
    forumId: number;
    authorId: number;
    operatorId: number;
    byModerator: boolean;
  };
  "thread.moderated": {
    threadId: number;
    operatorId: number;
    action: "lock" | "unlock" | "move" | "feature" | "pin";
    detail?: Record<string, unknown>;
  };
  /** 待审内容（版块需审核）：只发这个，审核通过才发 thread.created / thread.replied（M9 调同一迁移函数） */
  "content.submitted": {
    postId: number;
    threadId: number;
    authorId: number;
    forumId: number;
    /** true = 主题的首帖（审核的是主题） */
    isThread: boolean;
  };
  "content.moderated": {
    postId: number;
    operatorId: number;
    action: "approve" | "reject" | "remove" | "hide" | "restore";
    reason?: string;
  };
  "post.mentioned": { postId: number; authorId: number; mentionedUserId: number };
  "reaction.added": { userId: number; postId: number; kind: string };
  /** M10 投票：user 投给 poll 的（改票=最后一次的选项集）；仅审计，无消费者 */
  "poll.voted": { userId: number; pollId: number; optionIds: number[] };
  "message.sent": {
    conversationId: number;
    messageId: number;
    senderId: number;
    recipientId: number;
  };
  "attachment.uploaded": { attachmentId: number; fileId: number; uploaderId: number };
  "restriction.changed": {
    userId: number;
    kind: "ban" | "mute" | "no_avatar" | "no_signature";
    action: "created" | "lifted";
    operatorId: number;
    reason?: string;
    endsAt?: string | null;
  };
  "role.changed": {
    userId: number;
    roleKey: string;
    scopeId: number;
    action: "granted" | "revoked";
    operatorId: number;
  };
  "announcement.published": { announcementId: number; createdBy: number };
  "points.changed": { userId: number; channel: string; delta: number };
  "gate.unlocked": { gateId: number; userId: number; authorId: number; price: number };
  "badge.awarded": { userId: number; badgeId: number };
  "checkin.done": { userId: number; streak: number };
}

export type EventName = keyof EventPayloads;
export type EventConsumer<K extends EventName = EventName> = (
  payload: EventPayloads[K],
) => void | Promise<void>;

// ---------- 槽位清单（M2 仅启用 home.*；页面级槽位随 M3 建页扩充） ----------
// M7 新增：profile.header（资料页徽章卡）/ thread.user-badge（帖子页作者行的荣誉徽章位）——docs/MODULES.md 留档
export type SlotName =
  | "home.after-header"
  /** 首页右栏（仅 xl 宽桌侧栏渲染）：签到卡等次要信息位 */
  | "home.rail"
  | "home.footer-notice"
  | "profile.header"
  | "thread.user-badge";

/** 槽位渲染上下文：最小起步，M3 随页面语义扩展（threadId/forumId/user 等）。M7 扩 userId */
export interface SlotContext {
  pathname?: string;
  /** 目标用户 id（profile.header = 资料页主人；thread.user-badge = 楼层作者） */
  userId?: number;
}

export type SlotRenderer = (ctx: SlotContext) => Promise<ReactNode> | ReactNode;

// ---------- 九类注册边界（M2 的六类 + M5.5 新增三类；真实消费者随里程碑落地。M6.1 删除了 gateConditions：门控条件固定为内置 points / reply） ----------

/** 权限点：M5 authz 内核消费 */
export interface PermissionPointDef {
  key: string; // resource.action，词汇表见 docs/AUTHZ.md
  description: string;
}

/** 导航项：M10 站点框架消费 */
export interface NavItemDef {
  id: string;
  label: string;
  href: string;
  order?: number;
}

/** cron 任务：M13 基建消费 */
export interface CronJobDef {
  name: string;
  schedule: string; // cron 表达式（M13 前不调度，仅登记）
  run: () => Promise<void>;
}

/** Drizzle schema 片段：M7 gamification 首个真实消费者 */
export type SchemaFragment = MySqlTable;

/** 令牌覆盖：语义层 CSS 变量 → 值（主题包之外的最小定制面） */
export type TokenOverrides = Record<string, string>;

/**
 * 积分渠道（docs/POINTS.md §3）：积分变动只能经 applyPoints，且渠道须先注册。
 * key 命名空间决定方向：earn.* 只能加分，spend.* 只能扣分，adjust.* 双向。
 */
export type PointDirection = "earn" | "spend" | "adjust";
export interface PointChannelDef {
  key: string;
  direction: PointDirection;
  label: string;
  /** 受日上限约束（按北京时间自然日、基于台账聚合）。契约已接受，规则执行随 M7 落地 */
  dailyCap?: boolean;
}

/** 通知类型（docs/NOTIFICATIONS.md §4）：M8 通知模块消费 */
export type NotificationCategory = "interaction" | "message" | "moderation" | "account";
export interface NotificationTypeDef {
  key: string;
  category: NotificationCategory;
  /** 同键未读通知合并为一条 */
  aggregate: boolean;
  /** 不可被用户关闭（审核、限制、安全类） */
  mandatory: boolean;
}

/** 通知投递渠道：当前仅内置 in_app；email / push 预留 */
export interface NotificationDelivery {
  id: number;
  userId: number;
  type: string;
  data: unknown;
}
export interface NotificationChannelDef {
  key: string;
  deliver: (n: NotificationDelivery, user: { id: number }) => Promise<void>;
}

// ---------- 模块定义 ----------

export interface ModuleDefinition {
  /** 全局唯一，kebab-case */
  id: string;
  description: string;
  /** 事件消费者：只声明关心的事件 */
  events?: { [K in EventName]?: EventConsumer<K> };
  /** 槽位渲染器：按注册序合并 */
  slots?: Partial<Record<SlotName, SlotRenderer>>;
  permissions?: PermissionPointDef[];
  nav?: NavItemDef[];
  cron?: CronJobDef[];
  schemaFragments?: SchemaFragment[];
  pointChannels?: PointChannelDef[];
  notificationTypes?: NotificationTypeDef[];
  notificationChannels?: NotificationChannelDef[];
  tokenOverrides?: TokenOverrides;
  /** 路由前缀约定：M3+ 模块自有页面按 src/app/(module-<id>)/… 组织 */
  routePrefix?: string;
}

/** defineModule：仅做类型收口与冻结，无运行时魔法 */
export function defineModule<M extends ModuleDefinition>(m: M): Readonly<M> {
  return Object.freeze({ ...m });
}
