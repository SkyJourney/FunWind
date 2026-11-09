import "server-only";

import { sql } from "drizzle-orm";
import { auditLog, getWebDb } from "@funwind/db";

/** 数据库执行器：连接本身或事务句柄（审计必须能跟随业务动作进同一事务） */
type Db = ReturnType<typeof getWebDb>;
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbExecutor = Db | DbTx;

/**
 * 配置类写操作（模块启停、站点设置）的操作者：Web 管理后台有登录用户；
 * 命令行脚本与开发接口没有，此时 userId 为 null，via 标明来源，写进审计的 after_json。
 * theme：站长设全站默认主题时由主题↔LOGO 联动触发的池写入（M11，docs/THEME-SYSTEM.md §5）。
 * install：安装管线（M12，向导与 CLI 共用同一状态机，docs/milestones/M12-install-wizard.md）。
 * pipeline：运维任务管线经内部动作接口写入（M14 节日装扮生成 campaigns，token 鉴权）。
 */
export interface ConfigActor {
  userId: number | null;
  via: "admin" | "cli" | "dev-api" | "theme" | "install" | "pipeline";
  ip?: string | null;
}

/** 脚本/默认调用方的操作者 */
export const CLI_ACTOR: ConfigActor = { userId: null, via: "cli" };

/** 安装管线（M12）的操作者：尚无会话身份，审计以 via="install" 标识 */
export const INSTALL_ACTOR: ConfigActor = { userId: null, via: "install" };

/** 运维任务管线（M14）的操作者：token 鉴权的服务间调用 */
export const PIPELINE_ACTOR: ConfigActor = { userId: null, via: "pipeline" };

export interface AuditEntry {
  actorId: number | null;
  /** 命名空间动作：role.create / grant.add / user_role.assign … */
  action: string;
  targetType: string;
  targetId: string | number;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/**
 * 写一条审计记录。务必传入业务动作所在的事务句柄：动作回滚则审计一并回滚，
 * 动作成功则审计必在——不存在“改了权限却没留痕”的窗口。
 */
export async function writeAudit(tx: DbExecutor, e: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actorId: e.actorId,
    action: e.action,
    targetType: e.targetType,
    targetId: String(e.targetId),
    beforeJson: e.before === undefined ? null : (e.before as object),
    afterJson: e.after === undefined ? null : (e.after as object),
    ip: e.ip ?? null,
    createdAt: sql`NOW()`,
  });
}
