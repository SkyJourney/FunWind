import type { MySqlTable } from "drizzle-orm/mysql-core";
import type { ReactNode } from "react";

/**
 * 模块内核契约（M2 定稿）。
 * 扩展事件/槽位清单 = 修改本文件并在 docs/MODULES.md 说明——模块不得私设插入点。
 */

// ---------- 事件清单（命名承接旧 phpwind 钩子语义：after_login → user.logged_in 等） ----------
export interface EventPayloads {
  "user.logged_in": { userId: number };
  "user.registered": { userId: number };
  "thread.created": { threadId: number; forumId: number; authorId: number };
  "thread.replied": { threadId: number; postId: number; authorId: number };
  "thread.edited": { threadId: number; editorId: number };
  "thread.deleted": { threadId: number; operatorId: number };
  "attachment.uploaded": { attachmentId: number; uploaderId: number };
  "credit.changed": { userId: number; creditType: string; delta: number };
  "medal.awarded": { userId: number; medalId: number };
  "checkin.done": { userId: number; streak: number };
}

export type EventName = keyof EventPayloads;
export type EventConsumer<K extends EventName = EventName> = (
  payload: EventPayloads[K],
) => void | Promise<void>;

// ---------- 槽位清单（M2 仅启用 home.*；页面级槽位随 M3 建页扩充） ----------
// 预留（M3+ 启用）：thread.sidebar / thread.after-content / forum.header / profile.tab / nav.right
export type SlotName = "home.after-header" | "home.footer-notice";

/** 槽位渲染上下文：最小起步，M3 随页面语义扩展（threadId/forumId/user 等） */
export interface SlotContext {
  pathname?: string;
}

export type SlotRenderer = (ctx: SlotContext) => Promise<ReactNode> | ReactNode;

// ---------- 六类注册边界（M2 最小实现；真实消费者随里程碑落地） ----------

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
  tokenOverrides?: TokenOverrides;
  /** 路由前缀约定：M3+ 模块自有页面按 src/app/(module-<id>)/… 组织 */
  routePrefix?: string;
}

/** defineModule：仅做类型收口与冻结，无运行时魔法 */
export function defineModule<M extends ModuleDefinition>(m: M): Readonly<M> {
  return Object.freeze({ ...m });
}
