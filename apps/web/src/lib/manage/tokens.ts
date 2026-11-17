import "server-only";

import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { adminApiTokens, getWebDb } from "@funwind/db";
import { writeAudit } from "@/lib/audit";
import { generateToken, hashToken } from "@/lib/auth/token";
import { AdminError } from "@/lib/authz/admin-error";
import { isEffectiveSiteAdmin, type AuthzTransaction } from "@/lib/authz/site-admin-invariant";

/**
 * 管理员 Access Token 的 Service 层（M20）。
 *
 * 分层纪律（M20 文档 §2）：签发/吊销/联动吊销的**全部业务语义（事务、上限、审计、不变量判定）
 * 内聚在本文件**；后台页面 Server Action 与（未来的）任何入口只做鉴权、参数解析与调用。
 *
 * 生命周期三重失效：
 *  - 自身过期：expires_at 到点即无效（resolveUsableApiToken 过滤，cleanup 物理删除）；
 *  - 手动吊销：后台页一键吊销（revokeAdminApiToken）；
 *  - 撤权联动吊销：持有人不再满足站点管理员不变量时，触发降权的业务事务内调用
 *    revokeAdminApiTokensIfNotSiteAdmin（与降权动作同事务提交/回滚，原子）。
 */

/** 每管理员有效 token 上限（D5）：超限先吊销旧的 */
export const ADMIN_API_TOKEN_LIMIT = 5;

/** 有效期档位（天，D2）：不允许永久 */
export const ADMIN_API_TOKEN_DAYS = [30, 90, 180, 365] as const;

/** 默认有效期（天） */
export const ADMIN_API_TOKEN_DEFAULT_DAYS: number = 90;

/** 明文前缀：标识这是 FunWind 管理 token（扫描器可识别，避免误提交告警误报项目源码） */
const TOKEN_PREFIX = "fw_at_";

/** last_used 落库节流：距上次使用超过该秒数才写（对齐 sessions.lastSeenAt 的写放大防护） */
export const TOKEN_USAGE_TOUCH_INTERVAL_SEC = 60;

/**
 * 签发明文的**一次性展示暂存**（进程内存）：defineAction 恒 void + redirect 收尾，明文无法经
 * 返回值带回页面，也不能进 URL/cookie/日志——先暂存，页面按 `?created=<id>` 取走即删。
 * 安全面：命中即删（刷新不重放）+ TTL 兜底（未取走 60s 自动失效）+ 容量上限（签发低频，>32 全清过期）。
 * 单实例部署前提（与 lib/auth/ratelimit 同）；多实例时本缓存需换集中存储。
 */
const PENDING_PLAIN_TTL_MS = 60_000;
const pendingPlains = new Map<string, { plain: string; expiresAt: number }>();

export function stashPlainForOnce(tokenId: string, plain: string): void {
  const now = Date.now();
  // 低频签发下的简单防泄漏：容量超限时先清过期，仍满则丢最旧
  if (pendingPlains.size >= 32) {
    for (const [k, v] of pendingPlains) {
      if (v.expiresAt <= now) pendingPlains.delete(k);
    }
    if (pendingPlains.size >= 32) {
      const oldest = pendingPlains.keys().next().value;
      if (oldest !== undefined) pendingPlains.delete(oldest);
    }
  }
  pendingPlains.set(tokenId, { plain, expiresAt: now + PENDING_PLAIN_TTL_MS });
}

/** 取走即删：命中返回明文（页面唯一展示时机），未命中/过期返回 null（刷新/转发不重放） */
export function takePlainOnce(tokenId: string): string | null {
  const hit = pendingPlains.get(tokenId);
  pendingPlains.delete(tokenId);
  if (!hit || hit.expiresAt <= Date.now()) return null;
  return hit.plain;
}

/** 仅测试使用：清空一次性暂存 */
export function resetPendingPlains(): void {
  pendingPlains.clear();
}

/** 明文形如 fw_at_<43 字符 base64url>；返回明文与库内哈希主键 */
export function buildPlainToken(): { plain: string; id: string } {
  const plain = TOKEN_PREFIX + generateToken();
  return { plain, id: hashToken(plain) };
}

/** 列表辨识用的明文尾 8 字符（非凭证，不参与任何校验） */
export function tokenSuffixOf(plain: string): string {
  return plain.slice(-8);
}

/** 有效期档位校验（Service 自证健壮：入口层 zod 之外的第二道闸） */
export function ensureTokenDurationDays(days: number): number {
  if (!(ADMIN_API_TOKEN_DAYS as readonly number[]).includes(days)) {
    throw new AdminError("有效期仅支持 30 / 90 / 180 / 365 天。");
  }
  return days;
}

/** 展示名校验：去除首尾空白后 1–64 字符 */
export function ensureTokenName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    throw new AdminError("名称需为 1–64 个字符。");
  }
  return trimmed;
}

export type CreatedAdminApiToken = {
  /** 明文 token，仅签发响应中返回一次 */
  plain: string;
  /** 库内哈希主键 */
  id: string;
  name: string;
  suffix: string;
  /** 过期时刻（北京墙面时间字符串） */
  expiresAt: string;
};

/**
 * 签发管理 token（后台页面调用）。事务内完成：有效数量上限校验 → 落库 → 审计。
 * 明文只在本函数返回值中出现一次，任何日志/回跳都不得携带。
 */
export async function createAdminApiToken(input: {
  userId: number;
  name: string;
  days: number;
  /** 操作者（页面签发时即持有人本人） */
  actor: { userId: number | null; via: "admin" | "api" };
  ip?: string | null;
}): Promise<CreatedAdminApiToken> {
  const name = ensureTokenName(input.name);
  const days = ensureTokenDurationDays(input.days);
  const { plain, id } = buildPlainToken();

  return getWebDb().transaction(async (tx) => {
    // 上限按「有效 token」计：已吊销/已过期的行不占名额（过期行由 cleanup 物理删除）
    const [usage] = await tx
      .select({ n: count() })
      .from(adminApiTokens)
      .where(
        and(
          eq(adminApiTokens.userId, input.userId),
          isNull(adminApiTokens.revokedAt),
          gt(adminApiTokens.expiresAt, sql`NOW()`),
        ),
      );
    if (Number(usage?.n ?? 0) >= ADMIN_API_TOKEN_LIMIT) {
      throw new AdminError(`最多签发 ${ADMIN_API_TOKEN_LIMIT} 个有效 Token，请先吊销不再使用的。`);
    }

    // 主键为哈希字符串，drizzle 的 $returningId 不适用，插入后回查补齐过期时刻供一次性展示
    await tx.insert(adminApiTokens).values({
      id,
      userId: input.userId,
      name,
      suffix: tokenSuffixOf(plain),
      createdAt: sql`NOW()`,
      expiresAt: sql`NOW() + INTERVAL ${days} DAY`,
      createdVia: "admin",
    });
    const [row] = await tx
      .select({ expiresAt: adminApiTokens.expiresAt })
      .from(adminApiTokens)
      .where(eq(adminApiTokens.id, id))
      .limit(1);

    await writeAudit(tx, {
      actorId: input.actor.userId,
      action: "api_token.create",
      targetType: "admin_api_token",
      targetId: id,
      after: { name, suffix: tokenSuffixOf(plain), days, via: input.actor.via },
      ip: input.ip ?? null,
    });

    return { plain, id, name, suffix: tokenSuffixOf(plain), expiresAt: row?.expiresAt ?? "" };
  });
}

export type UsableAdminApiToken = {
  id: string;
  userId: number;
  name: string;
  suffix: string;
};

/** 门禁用：按明文解析可用 token；查无 / 已吊销 / 已过期一律返回 null（存在性不泄露） */
export async function resolveUsableApiToken(plain: string): Promise<UsableAdminApiToken | null> {
  const [row] = await getWebDb()
    .select({
      id: adminApiTokens.id,
      userId: adminApiTokens.userId,
      name: adminApiTokens.name,
      suffix: adminApiTokens.suffix,
    })
    .from(adminApiTokens)
    .where(
      and(
        eq(adminApiTokens.id, hashToken(plain)),
        isNull(adminApiTokens.revokedAt),
        gt(adminApiTokens.expiresAt, sql`NOW()`),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 手动吊销（后台页调用）。事务 + 审计；重复吊销幂等返回 false（调用方给「已吊销」提示）。
 * 仅允许持有人本人操作（userId 归属校验在查询条件内）。
 */
export async function revokeAdminApiToken(input: {
  tokenId: string;
  userId: number;
  actor: { userId: number | null; via: "admin" | "api" };
  ip?: string | null;
}): Promise<boolean> {
  return getWebDb().transaction(async (tx) => {
    const [row] = await tx
      .select({
        name: adminApiTokens.name,
        suffix: adminApiTokens.suffix,
        revokedAt: adminApiTokens.revokedAt,
      })
      .from(adminApiTokens)
      .where(and(eq(adminApiTokens.id, input.tokenId), eq(adminApiTokens.userId, input.userId)))
      .limit(1)
      .for("update");
    if (!row || row.revokedAt !== null) return false;

    await tx
      .update(adminApiTokens)
      .set({ revokedAt: sql`NOW()` })
      .where(eq(adminApiTokens.id, input.tokenId));

    await writeAudit(tx, {
      actorId: input.actor.userId,
      action: "api_token.revoke",
      targetType: "admin_api_token",
      targetId: input.tokenId,
      before: { name: row.name, suffix: row.suffix },
      after: { via: input.actor.via },
      ip: input.ip ?? null,
    });
    return true;
  });
}

/**
 * 撤权联动吊销（D4）：持有人不再满足站点管理员不变量 → 吊销其全部未吊销 token。
 * **必须在触发降权的业务事务内调用**（site-admin-invariant 同族：事务内实时判定，
 * 与降权动作同事务提交/回滚，保证「降权生效 ⇔ token 失效」原子）。
 * 返回吊销的行数（0 = 仍满足不变量，或本就没有 token）。
 */
export async function revokeAdminApiTokensIfNotSiteAdmin(
  tx: AuthzTransaction,
  userId: number,
  /** 触发降权的管理操作者（审计记触发者；缺省视为系统判定） */
  trigger?: { actorId: number | null; via: string },
): Promise<number> {
  if (await isEffectiveSiteAdmin(tx, userId)) return 0;

  const victims = await tx
    .select({ id: adminApiTokens.id, name: adminApiTokens.name, suffix: adminApiTokens.suffix })
    .from(adminApiTokens)
    .where(and(eq(adminApiTokens.userId, userId), isNull(adminApiTokens.revokedAt)));
  if (victims.length === 0) return 0;

  await tx.delete(adminApiTokens).where(
    // 只删未吊销的行：已吊销行保留撤销时刻供审计观察（cleanup 按保留期物理删除）
    and(eq(adminApiTokens.userId, userId), isNull(adminApiTokens.revokedAt)),
  );

  await writeAudit(tx, {
    actorId: trigger?.actorId ?? null,
    action: "api_token.cascade_revoke",
    targetType: "user",
    targetId: userId,
    before: victims.map((v) => ({ name: v.name, suffix: v.suffix })),
    after: { count: victims.length, triggerVia: trigger?.via ?? "system" },
  });
  return victims.length;
}

/** 单语句原子节流：距上次落库超过间隔才更新（无需先读后写，无竞态） */
export async function touchApiTokenUsage(tokenId: string, ip: string | null): Promise<void> {
  await getWebDb()
    .update(adminApiTokens)
    .set({
      lastUsedAt: sql`NOW()`,
      // 取不到可信 IP 时保留旧值，不清空观测线索
      ...(ip ? { lastUsedIp: ip } : {}),
    })
    .where(
      and(
        eq(adminApiTokens.id, tokenId),
        // 括号必须有：drizzle 不为 sql 模板自动加括号，裸 OR 会撕裂外层 AND
        sql`(${adminApiTokens.lastUsedAt} IS NULL OR ${adminApiTokens.lastUsedAt} <= NOW() - INTERVAL ${sql.raw(String(TOKEN_USAGE_TOUCH_INTERVAL_SEC))} SECOND)`,
      ),
    );
}

export type AdminApiTokenListItem = {
  id: string;
  name: string;
  suffix: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  /** 未吊销且未过期（SQL 内按 NOW() 判定） */
  active: boolean;
};

/** 某管理员的全部 token（上限 5 个，无需分页），新签在前 */
export async function listAdminApiTokens(userId: number): Promise<AdminApiTokenListItem[]> {
  return getWebDb()
    .select({
      id: adminApiTokens.id,
      name: adminApiTokens.name,
      suffix: adminApiTokens.suffix,
      createdAt: adminApiTokens.createdAt,
      expiresAt: adminApiTokens.expiresAt,
      lastUsedAt: adminApiTokens.lastUsedAt,
      lastUsedIp: adminApiTokens.lastUsedIp,
      revokedAt: adminApiTokens.revokedAt,
      active: sql<boolean>`(${adminApiTokens.revokedAt} IS NULL AND ${adminApiTokens.expiresAt} > NOW())`,
    })
    .from(adminApiTokens)
    .where(eq(adminApiTokens.userId, userId))
    .orderBy(desc(adminApiTokens.createdAt));
}
