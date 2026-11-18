import "server-only";

import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { adminApiTokens, affectedRowsOf, getWebDb } from "@funwind/db";
import { writeAudit } from "@/lib/audit";
import { getRegisterMode } from "@/lib/auth/settings";
import { generateToken, hashToken } from "@/lib/auth/token";
import { AdminError } from "@/lib/authz/admin-error";
import { checkPermission } from "@/lib/authz/service";
import {
  isEffectiveSiteAdmin,
  lockSiteAdminInvariant,
  type AuthzTransaction,
} from "@/lib/authz/site-admin-invariant";
import { loadFreshAuthzSnapshot } from "@/lib/authz/snapshot";
import { loadSubject, loadSubjectFrom } from "@/lib/authz/subject";
import type { AuthzSnapshot, Subject } from "@/lib/authz/types";
import {
  expandManagePermissionSelection,
  getManageEndpoint,
  LEGACY_M20_ENDPOINTS,
  MANAGE_ENDPOINTS,
  parseManagePermissionSnapshot,
  type ManageEndpointId,
} from "@/lib/manage/permissions";

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

/** 旧版只接受历史前缀；细粒度凭证退版后失效，不会被当成九读令牌。 */
const TOKEN_PREFIXES = {
  legacy_m20_read: "fw_at_",
  scoped_v2: "fw_at2_",
} as const;

type ManageTokenProfile = keyof typeof TOKEN_PREFIXES;
type StoredManageTokenGrant = {
  permissionProfile: string;
  permissionSnapshot: unknown;
  snapshotIsSqlNull: number;
};

/** 读库时只认可两种授权模型；坏行不可用于认证或被展示为完整授权。 */
function endpointGrantsOf(row: StoredManageTokenGrant): readonly ManageEndpointId[] | null {
  if (row.permissionProfile === "legacy_m20_read") {
    return row.snapshotIsSqlNull === 1 ? LEGACY_M20_ENDPOINTS : null;
  }
  return row.permissionProfile === "scoped_v2"
    ? parseManagePermissionSnapshot(row.permissionSnapshot)
    : null;
}

const permissionColumns = {
  permissionProfile: adminApiTokens.permissionProfile,
  permissionSnapshot: adminApiTokens.permissionSnapshot,
  snapshotIsSqlNull: sql`${adminApiTokens.permissionSnapshot} IS NULL`.mapWith(Number),
};

/** 只接受两种明确版本，不剥前缀或降级重试。 */
export function manageTokenProfileOf(plain: string): ManageTokenProfile | null {
  for (const profile of ["legacy_m20_read", "scoped_v2"] as const) {
    const prefix = TOKEN_PREFIXES[profile];
    if (
      plain.length === prefix.length + 43 &&
      plain.startsWith(prefix) &&
      /^[A-Za-z0-9_-]{43}$/.test(plain.slice(prefix.length))
    ) {
      return profile;
    }
  }
  return null;
}

/** last_used 落库节流：距上次使用超过该秒数才写（对齐 sessions.lastSeenAt 的写放大防护） */
export const TOKEN_USAGE_TOUCH_INTERVAL_SEC = 60;

/**
 * 签发明文的**一次性展示暂存**（进程内存）：defineAction 恒 void + redirect 收尾，明文无法经
 * 返回值带回页面，也不能进 URL/cookie/日志——先暂存，页面按 `?created=<id>` 取走即删。
 * 安全面：命中即删（刷新不重放）+ TTL 过期失效 + **绑定签发人**（他人凭审计里的哈希 id 也取不走）
 * + 每次签发顺带清扫过期键（堆内存不残留明文）+ 容量上限。
 * 单实例部署前提（与 lib/auth/ratelimit 同）；多实例时本缓存需换集中存储。
 */
const PENDING_PLAIN_TTL_MS = 60_000;
const pendingPlains = new Map<string, { plain: string; userId: number; expiresAt: number }>();

/** 清扫过期条目（每次签发顺带执行，明文不在堆内存长期滞留） */
function sweepExpiredPendingPlains(now: number): void {
  for (const [k, v] of pendingPlains) {
    if (v.expiresAt <= now) pendingPlains.delete(k);
  }
}

export function stashPlainForOnce(tokenId: string, plain: string, userId: number): void {
  const now = Date.now();
  sweepExpiredPendingPlains(now);
  // 低频签发下的简单防泄漏：容量超限时（清扫后仍满）丢最旧
  if (pendingPlains.size >= 32) {
    const oldest = pendingPlains.keys().next().value;
    if (oldest !== undefined) pendingPlains.delete(oldest);
  }
  pendingPlains.set(tokenId, { plain, userId, expiresAt: now + PENDING_PLAIN_TTL_MS });
}

/** 取走即删且仅签发人可取：命中返回明文（页面唯一展示时机）；未命中/过期返回 null（不删，TTL 兜底）；
 * 非本人访问返回 null 且**不消费条目**（凭审计泄漏的哈希 id 烧不掉签发人的一次性展示机会） */
export function takePlainOnce(tokenId: string, userId: number): string | null {
  const hit = pendingPlains.get(tokenId);
  if (!hit) return null;
  if (hit.userId !== userId) return null;
  pendingPlains.delete(tokenId);
  if (hit.expiresAt <= Date.now()) return null;
  return hit.plain;
}

/** 仅测试使用：清空一次性暂存 */
export function resetPendingPlains(): void {
  pendingPlains.clear();
}

/** 页面/Action 与 API 门禁共用的「有效站点管理员」资格口径（事务内实时判定） */
export async function isEffectiveSiteAdminOf(userId: number): Promise<boolean> {
  return getWebDb().transaction((tx) => isEffectiveSiteAdmin(tx, userId));
}

/** 按授权模型生成明文（版本前缀 + 43 字符）及其库内哈希主键。 */
export function buildPlainToken(profile: ManageTokenProfile = "legacy_m20_read"): {
  plain: string;
  id: string;
} {
  const plain = TOKEN_PREFIXES[profile] + generateToken();
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

type CreateAdminApiTokenInput = {
  userId: number;
  name: string;
  days: number;
  /** 操作者（页面签发时即持有人本人） */
  actor: { userId: number | null; via: "admin" | "api" };
  ip?: string | null;
};

/** 按持有人实时权限筛选端点；签发事务传入它自己的规则快照。 */
async function filterAssignableEndpoints(
  subject: Subject,
  ids: readonly ManageEndpointId[],
  snapshot?: AuthzSnapshot,
): Promise<ManageEndpointId[]> {
  if (subject.userId === null) return [];
  const matching = await Promise.all(
    ids.map(async (id) => {
      const { permission } = getManageEndpoint(id);
      return !permission || (await checkPermission(subject, permission, {}, snapshot)).allowed;
    }),
  );
  return ids.filter((_, index) => matching[index]);
}

/** 已通过页面资格门禁时，供表单区分未开放端点和缺少主体权限。 */
export async function getAssignableManageEndpointIds(userId: number): Promise<ManageEndpointId[]> {
  return filterAssignableEndpoints(
    await loadSubject(userId),
    Object.keys(MANAGE_ENDPOINTS) as ManageEndpointId[],
  );
}

/** 仅接受域和档位，在同一事务校验资格、权限和配额，再落库并审计。 */
export async function createScopedAdminApiToken(
  input: CreateAdminApiTokenInput & { permissions: unknown },
): Promise<CreatedAdminApiToken> {
  const permissionSnapshot = expandManagePermissionSelection(input.permissions);
  if (!permissionSnapshot) throw new AdminError("请选择至少一项可用的令牌权限。");
  if (input.actor.userId !== input.userId) throw new AdminError("无法为该账号签发令牌。");
  const name = ensureTokenName(input.name);
  const days = ensureTokenDurationDays(input.days);
  const { plain, id } = buildPlainToken("scoped_v2");
  // 注册模式读取可能触及其他服务，先读取；事务中只从 tx 取数。
  const registerMode = await getRegisterMode();

  return getWebDb().transaction(async (tx) => {
    // 和撤管理员、封禁、注销共用同一锁，也串行化两个签发对最后名额的竞争。
    await lockSiteAdminInvariant(tx);
    if (!(await isEffectiveSiteAdmin(tx, input.userId))) {
      throw new AdminError("只有有效站点管理员可以签发令牌。");
    }
    const subject = await loadSubjectFrom(tx, input.userId, registerMode);
    const snapshot = await loadFreshAuthzSnapshot(tx);
    const assignable = await filterAssignableEndpoints(subject, permissionSnapshot, snapshot);
    if (assignable.length !== permissionSnapshot.length) {
      throw new AdminError("不能授予持有人不具备的权限。");
    }
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
      permissionProfile: "scoped_v2",
      permissionSnapshot,
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
      after: {
        name,
        suffix: tokenSuffixOf(plain),
        days,
        via: input.actor.via,
        endpointGrants: permissionSnapshot,
      },
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
  endpointGrants: readonly ManageEndpointId[];
};

/** 门禁用：无效、过期、已吊销或前缀与授权模型不符一律返回 null。 */
export async function resolveUsableApiToken(plain: string): Promise<UsableAdminApiToken | null> {
  const profile = manageTokenProfileOf(plain);
  if (!profile) return null;
  const [row] = await getWebDb()
    .select({
      id: adminApiTokens.id,
      userId: adminApiTokens.userId,
      name: adminApiTokens.name,
      suffix: adminApiTokens.suffix,
      ...permissionColumns,
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
  if (!row || row.permissionProfile !== profile) return null;
  const endpointGrants = endpointGrantsOf(row);
  return endpointGrants
    ? { id: row.id, userId: row.userId, name: row.name, suffix: row.suffix, endpointGrants }
    : null;
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
  permissionProfile: string;
  /** null 表示存量行授权结构异常，不作九读回落。 */
  endpointGrants: readonly ManageEndpointId[] | null;
};

/** 某管理员的全部 token（上限 5 个，无需分页），新签在前 */
export async function listAdminApiTokens(userId: number): Promise<AdminApiTokenListItem[]> {
  const rows = await getWebDb()
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
      ...permissionColumns,
    })
    .from(adminApiTokens)
    .where(eq(adminApiTokens.userId, userId))
    .orderBy(desc(adminApiTokens.createdAt));
  return rows.map(({ permissionSnapshot, snapshotIsSqlNull, ...item }) => ({
    ...item,
    endpointGrants: endpointGrantsOf({
      permissionProfile: item.permissionProfile,
      permissionSnapshot,
      snapshotIsSqlNull,
    }),
  }));
}

// ── 凭据卫生清扫（api-tokens.cleanup 调度任务，M20 Step 6；顺还 sessions/email_tokens 两笔 GC 旧账） ──

/** token 过期/吊销后的物理删除保留期（天）：窗口内保留供审计排查异常使用 */
export const CREDENTIAL_RETENTION_TOKEN_DAYS = 30;
/** sessions 过期行的物理删除保留期（天）：过期会话无任何消费价值（M20 前无 GC，idx_sessions_expires 空挂） */
export const CREDENTIAL_RETENTION_SESSION_DAYS = 7;
/** email_tokens 已用/过期行的物理删除保留期（天）：签发事务的惰性清理只管同用户同用途配额，历史行长期堆积 */
export const CREDENTIAL_RETENTION_EMAIL_DAYS = 30;

export type CredentialCleanupStats = { tokens: number; sessions: number; emailTokens: number };

/**
 * 单表单批删除（上限 1000 行，防超长事务——与 push.cleanup 同口径）；
 * 积压场景由调度逐日消化。返回本批删除行数。
 */
async function deleteStaleBatch(table: string, staleCondition: string): Promise<number> {
  const result = await getWebDb().execute(
    sql.raw(`DELETE FROM ${table} WHERE ${staleCondition} LIMIT 1000`),
  );
  return affectedRowsOf(result);
}

/** 凭据卫生清扫一批（三类各至多 1000 行）；由 api-tokens.cleanup 每日 04:10 调度调用 */
export async function cleanupStaleCredentialRows(): Promise<CredentialCleanupStats> {
  const stats = { tokens: 0, sessions: 0, emailTokens: 0 };

  stats.tokens = await deleteStaleBatch(
    "admin_api_tokens",
    `expires_at < NOW() - INTERVAL ${CREDENTIAL_RETENTION_TOKEN_DAYS} DAY
      OR revoked_at < NOW() - INTERVAL ${CREDENTIAL_RETENTION_TOKEN_DAYS} DAY`,
  );
  stats.sessions = await deleteStaleBatch(
    "sessions",
    `expires_at < NOW() - INTERVAL ${CREDENTIAL_RETENTION_SESSION_DAYS} DAY`,
  );
  stats.emailTokens = await deleteStaleBatch(
    "email_tokens",
    `used_at < NOW() - INTERVAL ${CREDENTIAL_RETENTION_EMAIL_DAYS} DAY
      OR expires_at < NOW() - INTERVAL ${CREDENTIAL_RETENTION_EMAIL_DAYS} DAY`,
  );
  return stats;
}
