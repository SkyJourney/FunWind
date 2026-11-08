import "server-only";

import { count, eq, sql } from "drizzle-orm";
import type { RowDataPacket } from "mysql2/promise";
import {
  bootstrapDb,
  createDatabaseIfNotExists,
  getWebDb,
  getWebPool,
  newDbConfig,
  pingDatabase,
  userRoles,
  users,
} from "@funwind/db";
import { INSTALL_ACTOR, writeAudit } from "@/lib/audit";
import { ensureDefaultLogo } from "@/lib/brand/init-brand";
import { hashPassword } from "@/lib/auth/password";
import { registerUser } from "@/lib/auth/register";
import { setSettings } from "@/lib/auth/settings";
import { isInstalled, writeInstallLock } from "./lock";
import type { InstallConfig } from "./schema";

/**
 * 安装管线（M12，docs/milestones/M12-install-wizard.md）：向导与 CLI 共用的幂等状态机。
 * 六个步骤全部可重入——bootstrap 幂等（F1）、设置只补写、管理员在「唯一用户即目标管理员」时自愈补角色，
 * 中断（崩溃 / SIGKILL）后整体重跑即收敛，不留半成品。
 *
 * 双重防呆（规划 §3）：① lock 存在一律 already-installed；② 设置与管理员步骤仅在
 * `users` 表为空（或唯一用户正是目标管理员）时执行——lock 意外丢失的活跃站点也无法被改写。
 *
 * 连接口径：所有步骤都写**运行中实例配置的库**（newDbConfig()，与 getWebDb 同源），
 * 因此配置里的 db 连接信息必须与 env 完全一致（schema.ts 的 db-mismatch 校验），
 * 表单里改连接信息并不能让运行中的实例换库。
 */

export const INSTALL_STEPS = [
  "connection",
  "create-db",
  "bootstrap",
  "site-settings",
  "admin",
  "lock",
] as const;

export type InstallStep = (typeof INSTALL_STEPS)[number];

export type InstallErrorCode =
  | "already-installed"
  | "install-busy"
  | "db-unreachable"
  | "db-create-denied"
  | "db-mismatch"
  | "users-exist"
  | "bootstrap-failed"
  | "invalid-config";

export type InstallStepResult =
  { ok: true } | { ok: false; code: InstallErrorCode; message: string };

const ok: InstallStepResult = { ok: true };

const fail = (code: InstallErrorCode, message: string): InstallStepResult => ({
  ok: false,
  code,
  message,
});

/** 注册策略键值（M11.3 schema）：模式 → 三布尔 */
function registrationToPolicy(registration: InstallConfig["registration"]) {
  switch (registration.mode) {
    case "open":
      return { open: true, invite: false, verifyEmail: registration.verifyEmail };
    case "invite":
      return { open: false, invite: true, verifyEmail: false };
    case "closed":
      return { open: false, invite: false, verifyEmail: false };
  }
}

async function usersCount(): Promise<number> {
  const [row] = await getWebDb().select({ n: count() }).from(users);
  return Number(row?.n ?? 0);
}

/**
 * 设置与管理员步骤共用的防呆守卫（双重防呆的第二层，规划 §3）：
 *  · users 为空 → 放行（全新安装）；
 *  · 唯一用户恰为本配置的目标管理员 → 放行——--unlock 重装（同管理员重新配置）的收敛路径；
 *  · 其余（他人 / 多用户）→ users-exist 拒绝。lock 意外丢失的活跃站点因此无法被改写；
 *    换管理员的重装在此被拒，替换管理员请走后台（assignUserRole 等），不属于安装管线。
 */
async function installTargetGuard(config: InstallConfig): Promise<InstallStepResult | null> {
  let total: number;
  try {
    total = await usersCount();
  } catch (e) {
    // 零表（Server Action 可乱序调用，绕过向导顺序直达 step2/3）→ 结构化错误而非 500（审查 P2-⑪）
    console.error("[install] 读取用户数失败（库表可能尚未创建）:", e);
    return fail(
      "bootstrap-failed",
      "数据库尚未初始化：请先完成向导第 1 步（连接并建表），再进行本步骤。",
    );
  }
  if (total === 0) return null;
  if (total > 1) {
    return fail("users-exist", "数据库已有多个用户，拒绝执行安装写入（防重装保护）。");
  }
  const [row] = await getWebDb().select({ id: users.id, username: users.username }).from(users);
  if (row?.username !== config.admin.username) {
    return fail(
      "users-exist",
      "数据库已存在其他用户，拒绝执行安装写入（防重装保护）；如需更换管理员请走后台的用户管理。",
    );
  }
  return null;
}

/** 给用户补 admin 全局角色行 + 审计（崩溃窗口自愈与首次创建共用；唯一键兜底重复） */
async function grantAdminAndAudit(userId: number, config: InstallConfig): Promise<void> {
  await getWebDb().transaction(async (tx) => {
    await tx.insert(userRoles).values({
      userId,
      roleKey: "admin",
      scopeId: 0,
      grantedAt: sql`NOW()`,
    });
    await writeAudit(tx, {
      actorId: INSTALL_ACTOR.userId,
      action: "install.admin",
      targetType: "user",
      targetId: userId,
      before: null,
      after: { username: config.admin.username, role: "admin", via: INSTALL_ACTOR.via },
      ip: INSTALL_ACTOR.ip,
    });
  });
}

/**
 * 安装互斥锁（审查 P1-2）：installTargetGuard 是 check-then-act，两个安装者并发并以
 * 不同用户名创建管理员时会双双放行 → 双 admin 落库，且 users=2 永久卡死重装。
 * MySQL 命名锁（GET_LOCK，服务器级——调度器同款模式）把整条管线串行化：拿不到锁 = 已有
 * 安装在进行，直接 busy。锁名带库名（GET_LOCK 不分库）。连接持锁期间不能还池，
 * 所以锁的作用域是**一次 runInstallStep 调用**——分步向导的每一步各自拿锁；
 * 步骤之间靠幂等重入收敛，两个安装者交错分步时后到者会被 users 空表守卫/guard 语义拒绝。
 */
async function withInstallLock<T>(fn: () => Promise<T>): Promise<T | InstallStepResult> {
  const conn = await getWebPool().getConnection();
  let locked = false;
  try {
    const [dbRows] = await conn.query<RowDataPacket[]>("SELECT DATABASE() AS db");
    const name = `funwind_install:${String(dbRows[0]?.db ?? "")}`;
    const [rows] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS got", [name]);
    locked = Number(rows[0]?.got) === 1;
  } catch (error) {
    conn.destroy();
    throw error;
  }
  if (!locked) {
    conn.release();
    return fail("install-busy", "另一个安装正在进行中：请稍后重试或刷新页面。");
  }
  try {
    return await fn();
  } finally {
    try {
      const [dbRows] = await conn.query<RowDataPacket[]>("SELECT DATABASE() AS db");
      await conn.query("SELECT RELEASE_LOCK(?)", [
        `funwind_install:${String(dbRows[0]?.db ?? "")}`,
      ]);
    } catch {
      // 释放失败（连接已断）：GET_LOCK 随连接关闭自动释放，无需补救
    }
    conn.release();
  }
}

/**
 * 执行一步安装。step 粒度与向导的分步表单一一对应；`runInstall`（CLI / 完整安装）按
 * INSTALL_STEPS 顺序依次调用。所有步骤都必须先通过「未安装」检查（D2：lock 后全路由拒绝），
 * 并在安装互斥锁内执行（审查 P1-2）。
 */
export async function runInstallStep(
  step: InstallStep,
  config: InstallConfig,
): Promise<InstallStepResult> {
  if (await isInstalled()) {
    return fail(
      "already-installed",
      "站点已完成安装（存在 install.lock）。如需重装，请先用 install:cli --unlock 解锁。",
    );
  }
  const result = await withInstallLock(() => runInstallStepLocked(step, config));
  return result as InstallStepResult;
}

async function runInstallStepLocked(
  step: InstallStep,
  config: InstallConfig,
): Promise<InstallStepResult> {
  switch (step) {
    case "connection": {
      try {
        await pingDatabase(newDbConfig());
        return ok;
      } catch (e) {
        console.error("[install] 数据库连接失败:", e);
        return fail(
          "db-unreachable",
          "无法连接数据库：请核对主机、端口、用户与口令后重试（详见服务端日志）。",
        );
      }
    }

    case "create-db": {
      try {
        await createDatabaseIfNotExists(newDbConfig(), config.db.name, () => {});
        return ok;
      } catch (e) {
        console.error("[install] 建库失败:", e);
        // 分流（审查 P2-⑥）：连接类错误与权限类错误的提示不同，别让「刚连接成功」与「无权限」互相矛盾
        const code = (e as { code?: string } | null)?.code;
        if (code === "ER_DBACCESS_DENIED_ERROR" || code === "ER_ACCESS_DENIED_ERROR") {
          return fail(
            "db-create-denied",
            "创建数据库失败（账号缺少 CREATE 权限）：请手动创建数据库后重试——本步骤对已存在的库自动跳过。",
          );
        }
        return fail(
          "db-unreachable",
          "建库时无法连接数据库：请核对连接信息后重试（详见服务端日志）。",
        );
      }
    }

    case "bootstrap": {
      try {
        await bootstrapDb(newDbConfig(), () => {});
        return ok;
      } catch (e) {
        console.error("[install] 建表/系统种子失败:", e);
        const code = (e as { code?: string } | null)?.code;
        if (code === "ECONNREFUSED" || code === "ER_ACCESS_DENIED_ERROR") {
          return fail("db-unreachable", "建表时无法连接数据库：请核对连接信息后重试。");
        }
        return fail(
          "bootstrap-failed",
          "建表或系统种子失败：请查看服务端日志后重试（管线幂等，可安全重跑）。",
        );
      }
    }

    case "site-settings": {
      const guard = await installTargetGuard(config);
      if (guard) return guard;
      await setSettings(
        [
          { key: "register.policy", value: registrationToPolicy(config.registration) },
          {
            key: "site.identity",
            value: { name: config.site.name, tagline: config.site.tagline, url: config.site.url },
          },
          { key: "site.theme", value: { pack: config.themePack } },
        ],
        INSTALL_ACTOR,
      );
      // 默认站标（M13 D2）：零数据安装即得品牌；池已有当前项时幂等跳过。
      // 附带动作——失败只记日志不 fail 步骤（与 applyPackLogo 的语义一致），重装/重跑可收敛。
      const brand = await ensureDefaultLogo(INSTALL_ACTOR);
      if (brand.action === "initialized") console.log("[install] 默认站标已初始化：", brand.file);
      if (brand.action === "failed") {
        console.error("[install] 默认站标初始化失败（可稍后用 pnpm init-brand 补）:", brand.reason);
      }
      return ok;
    }

    case "admin": {
      const guard = await installTargetGuard(config);
      if (guard) return guard;
      const [existing] = await getWebDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, config.admin.username));
      if (existing) {
        // 崩溃窗口自愈：唯一用户正是目标管理员但角色行缺失（建用户后、写角色前崩溃）→ 补齐
        const [role] = await getWebDb()
          .select({ id: userRoles.id })
          .from(userRoles)
          .where(
            sql`${userRoles.userId} = ${existing.id} AND ${userRoles.roleKey} = 'admin' AND ${userRoles.scopeId} = 0`,
          );
        if (role) return ok; // 已完成（重入）
        await grantAdminAndAudit(existing.id, config);
        return ok;
      }
      const passwordHash = await hashPassword(config.admin.password);
      try {
        const id = await registerUser({
          username: config.admin.username,
          email: config.admin.email,
          passwordHash,
          invite: null,
        });
        await grantAdminAndAudit(id, config);
      } catch (e) {
        if (e instanceof Error && e.name === "RegisterError") {
          return fail("users-exist", `管理员账号创建失败：${e.message}`);
        }
        // 其余异常（DB 故障 / 自愈并发唯一键冲突）包成结构化结果，不绕开 InstallStepResult 契约（审查 P2-⑤）
        console.error("[install] 管理员创建失败:", e);
        return fail(
          "bootstrap-failed",
          "管理员创建失败：请查看服务端日志后重试（管线幂等，可安全重跑）。",
        );
      }
      return ok;
    }

    case "lock": {
      // 先审计后写文件：崩溃窗口里重跑会重复一条 install.locked 审计（可接受），
      // 反过来先写文件则审计可能永久丢失。异常包成结构化结果（审查 P2-⑤）。
      try {
        await writeAudit(getWebDb(), {
          actorId: INSTALL_ACTOR.userId,
          action: "install.locked",
          targetType: "install",
          targetId: "install.lock",
          after: { site: config.site.name, via: INSTALL_ACTOR.via },
          ip: INSTALL_ACTOR.ip,
        });
        await writeInstallLock({ installedAt: new Date().toISOString() });
        return ok;
      } catch (e) {
        console.error("[install] 写入安装锁失败:", e);
        return fail(
          "bootstrap-failed",
          "写入安装锁失败（多为 STORAGE_DIR 不可写）：请检查磁盘权限后重试。",
        );
      }
    }
  }
}

/** 完整安装：按顺序执行全部步骤，任一步失败即返回该步结果（重跑收敛）；整体在互斥锁内 */
export async function runInstall(config: InstallConfig): Promise<InstallStepResult> {
  for (const step of INSTALL_STEPS) {
    const result = await runInstallStep(step, config);
    if (!result.ok) return result;
  }
  return ok;
}
