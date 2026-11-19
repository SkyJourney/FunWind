import { randomBytes } from "node:crypto";
import { alias } from "drizzle-orm/mysql-core";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { affectedRowsOf, getWebDb, inviteCodes, users } from "@funwind/db";
import { writeAudit, type DbTx } from "@/lib/audit";
import { pageBounds } from "@/lib/paging";
import type {
  ModerationApiTrace,
  ModerationWriteDenial,
  PreparedModerationWrite,
} from "@/lib/moderation/contents";

/**
 * 邀请码管理（M10.6b，docs/milestones/M10.6-feature-completion.md 批次 b）：
 * 批量生成 / 列表 / 撤销未用码。消费侧零改动（register.ts 原子 UPDATE：未用且未过期才可用）。
 * 码面 12 位去易混字符（Crockford 口径去 0/O/1/I/L），`XXXX-XXXX-XXXX` 展示与入库同值（varchar 32）。
 */

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function formatCode(raw: string): string {
  return (raw.match(/.{1,4}/g) ?? []).join("-");
}

function randomCode(): string {
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return formatCode(out);
}

export interface InviteRow {
  code: string;
  createdBy: number | null;
  createdByName: string | null;
  usedBy: number | null;
  usedByName: string | null;
  usedAt: string | null;
  expiresAt: string | null;
  batch: string;
  createdAt: string;
  status: "available" | "used" | "expired";
}

/** datetime(mode:"string") 是 "YYYY-MM-DD HH:MM:SS"；转 ISO 才能可靠 parse */
const ts = (s: string): number => new Date(s.replace(" ", "T")).getTime();

export type InviteStatusFilter = "all" | "available" | "used" | "expired";

export type InvitePageFilters = {
  status: InviteStatusFilter;
  /** 批次关键词（包含匹配） */
  batch?: string;
  /** 创建时间下界（含；M19 S4） */
  since?: string;
  /** 创建时间上界（含当天——调用方传 `${date} 23:59:59`） */
  until?: string;
  page: number;
  perPage?: number;
};

/** 邀请码分页（M9.5；M19 S4 加创建时间范围）：状态/批次/时间筛选下推 SQL（状态在 SQL 侧用同一套 used/expired 口径表达） */
export async function listInvitesPage(filters: InvitePageFilters): Promise<{
  items: InviteRow[];
  total: number;
  page: number;
  totalPages: number;
}> {
  const perPage = filters.perPage ?? 20;
  const conds = [];
  if (filters.status === "used") conds.push(sql`${inviteCodes.usedAt} IS NOT NULL`);
  if (filters.status === "available")
    conds.push(
      sql`${inviteCodes.usedAt} IS NULL AND (${inviteCodes.expiresAt} IS NULL OR ${inviteCodes.expiresAt} > NOW())`,
    );
  if (filters.status === "expired")
    conds.push(
      sql`${inviteCodes.usedAt} IS NULL AND ${inviteCodes.expiresAt} IS NOT NULL AND ${inviteCodes.expiresAt} <= NOW()`,
    );
  const batch = filters.batch?.trim();
  if (batch) conds.push(sql`${inviteCodes.batch} LIKE ${`%${batch}%`}`);
  if (filters.since) conds.push(gte(inviteCodes.createdAt, filters.since));
  if (filters.until) conds.push(lte(inviteCodes.createdAt, filters.until));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const creator = alias(users, "invite_creator");
  const usedByUser = alias(users, "invite_used_by");
  const [countRow] = await getWebDb()
    .select({ total: sql<number>`COUNT(*)` })
    .from(inviteCodes)
    .where(where);
  const total = Number(countRow?.total ?? 0);
  const { page, totalPages, offset } = pageBounds(total, filters.page, perPage);
  const rows = await getWebDb()
    .select({
      code: inviteCodes.code,
      createdBy: inviteCodes.createdBy,
      createdByName: creator.username,
      usedBy: inviteCodes.usedBy,
      usedByName: usedByUser.username,
      usedAt: inviteCodes.usedAt,
      expiresAt: inviteCodes.expiresAt,
      batch: inviteCodes.batch,
      createdAt: inviteCodes.createdAt,
    })
    .from(inviteCodes)
    .leftJoin(creator, eq(inviteCodes.createdBy, creator.id))
    .leftJoin(usedByUser, eq(inviteCodes.usedBy, usedByUser.id))
    .where(where)
    .orderBy(desc(inviteCodes.createdAt))
    .limit(perPage)
    .offset(offset);

  const now = Date.now();
  return {
    items: rows.map((r) => ({
      ...r,
      status:
        r.usedAt !== null
          ? "used"
          : r.expiresAt !== null && ts(r.expiresAt) <= now
            ? "expired"
            : "available",
    })),
    total,
    page,
    totalPages,
  };
}

/** 撤销某批次全部可用码（M9.5 批量撤销）：一条批次级审计（count 进 after）；已用码不受影响 */
export async function revokeInvitesByBatch(
  actor: { userId: number | null; ip?: string | null },
  batch: string,
): Promise<{ ok: true; revoked: number } | { ok: false; code: "not_found" }> {
  const db = getWebDb();
  const result = await db.transaction(async (tx: DbTx) => {
    const revoked = await applyInviteRevokeByBatch(tx, actor, batch);
    if (revoked === null) return { ok: false as const, code: "not_found" as const };
    return { ok: true as const, revoked };
  });
  return result;
}

export type InviteGenInput = {
  count: number;
  /** 有效天数；0 = 永不过期 */
  days: number;
  batch: string;
};

export async function generateInvites(
  actor: { userId: number | null; ip?: string | null },
  input: InviteGenInput,
): Promise<{ ok: true; codes: string[] }> {
  const db = getWebDb();
  const codes = await db.transaction((tx: DbTx) => applyInviteGenerate(tx, actor, input));
  return { ok: true, codes };
}

export async function revokeInvite(
  actor: { userId: number | null; ip?: string | null },
  code: string,
): Promise<{ ok: true } | { ok: false; code: "not_found" | "already_used" }> {
  const db = getWebDb();
  const result = await db.transaction(async (tx: DbTx) => {
    const [row] = await tx
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.code, code))
      .limit(1)
      .for("update");
    if (!row) return { ok: false as const, code: "not_found" as const };
    if (row.usedBy !== null) return { ok: false as const, code: "already_used" as const };
    await applyInviteRevoke(tx, actor, code, row);
    return { ok: true as const };
  });
  return result;
}

// ============================================================
// 共享写入内核 + REST 写变体（M20.3 Step 3）：后台入口与 prepare 变体共用
// apply 内核；trace 仅 REST 传入时附加到审计 after（后台审计形态不变）。
// 幂等契约：already_used 与「批次无可用码」等可变状态裁决在 execute；
// 合法回放已被幂等缓存短路，不会重复生成或重复删除。
// ============================================================

/** 业务拒绝码 → 对外信封映射（REST 适配层使用）。 */
export const INVITES_DENIAL_HTTP = {
  not_found: "not_found",
  already_used: "state_conflict",
} as const;

type InviteActor = { userId: number | null; ip?: string | null };
type InviteDenialCode = "not_found" | "already_used";
type InviteDenial = ModerationWriteDenial<InviteDenialCode>;

const inviteTraceFields = (trace?: ModerationApiTrace) =>
  trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {};

/** 生成内核（事务内）：逐条 insert（唯一键冲突换码重试 ≤5 次）+ 一条批次级审计。 */
async function applyInviteGenerate(
  tx: DbTx,
  actor: InviteActor,
  input: InviteGenInput,
  trace?: ModerationApiTrace,
): Promise<string[]> {
  const expiresAt = input.days > 0 ? sql`NOW() + INTERVAL ${input.days} DAY` : null;
  const codes: string[] = [];
  // 主键冲突极少（62^12 空间）；冲突重试由唯一键报错→整体回滚→外层重试
  for (let i = 0; i < input.count; i++) {
    let code = randomCode();
    for (let attempt = 0; ; attempt++) {
      try {
        await tx.insert(inviteCodes).values({
          code,
          createdBy: actor.userId,
          expiresAt,
          batch: input.batch,
          createdAt: sql`NOW()`,
        });
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        code = randomCode();
      }
    }
    codes.push(code);
  }
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "invite.generate",
    targetType: "invite_batch",
    targetId: input.batch || "-",
    after: { count: input.count, days: input.days, codes, ...inviteTraceFields(trace) },
    ip: actor.ip,
  });
  return codes;
}

/** 吊销内核（事务内）：物理删除 + 审计。 */
async function applyInviteRevoke(
  tx: DbTx,
  actor: InviteActor,
  code: string,
  row: { batch: string; expiresAt: string | null },
  trace?: ModerationApiTrace,
): Promise<void> {
  await tx.delete(inviteCodes).where(eq(inviteCodes.code, code));
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "invite.revoke",
    targetType: "invite",
    targetId: code,
    before: { batch: row.batch, expiresAt: row.expiresAt },
    after: { revoked: true, ...inviteTraceFields(trace) },
    ip: actor.ip,
  });
}

/** 批次吊销内核（事务内）：删除该批次全部可用码；无可用码返回 null（not_found）。 */
async function applyInviteRevokeByBatch(
  tx: DbTx,
  actor: InviteActor,
  batch: string,
  trace?: ModerationApiTrace,
): Promise<number | null> {
  const out = await tx
    .delete(inviteCodes)
    .where(and(eq(inviteCodes.batch, batch), isNull(inviteCodes.usedAt)));
  // M20.3 Step 3 修复预存缺陷：直接在 drizzle 结果数组上取 .affectedRows 恒为 undefined，
  // 批次吊销实际删码却恒报 not_found 且不写审计；改用 affectedRowsOf 取行数。
  const revoked = affectedRowsOf(out);
  if (revoked === 0) return null;
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "invite.revoke_batch",
    targetType: "invite_batch",
    targetId: batch,
    after: { revoked, ...inviteTraceFields(trace) },
    ip: actor.ip,
  });
  return revoked;
}

export type PreparedInviteWrite = PreparedModerationWrite<
  { codes?: string[]; count?: number; batch?: string; code?: string; revoked?: number | boolean },
  InviteDenialCode
>;

/** REST 批量生成邀请码：上限规则（≤20/次、days ≤3650、batch ≤64）由请求体 zod 与后台同规则承担。 */
export async function prepareApiInviteGenerate(
  actor: InviteActor,
  input: InviteGenInput,
  trace?: ModerationApiTrace,
): Promise<PreparedInviteWrite | InviteDenial> {
  return {
    ok: true,
    async lock(tx) {
      // 生成无行锁目标；随机码唯一键冲突在事务内换码重试
      return {
        ok: true as const,
        async execute() {
          const codes = await applyInviteGenerate(tx, actor, input, trace);
          return {
            ok: true as const,
            data: { codes, count: input.count, batch: input.batch },
          };
        },
      };
    },
  };
}

/** REST 吊销单条邀请码：存在性在锁段；已用拒绝在 execute（回放短路后不再误拒）。 */
export async function prepareApiInviteRevoke(
  actor: InviteActor,
  code: string,
  trace?: ModerationApiTrace,
): Promise<PreparedInviteWrite | InviteDenial> {
  return {
    ok: true,
    async lock(tx) {
      const [row] = await tx
        .select()
        .from(inviteCodes)
        .where(eq(inviteCodes.code, code))
        .limit(1)
        .for("update");
      if (!row) return { ok: false as const, code: "not_found" as const };
      return {
        ok: true as const,
        async execute() {
          if (row.usedBy !== null) return { ok: false as const, code: "already_used" as const };
          await applyInviteRevoke(tx, actor, code, row, trace);
          return { ok: true as const, data: { code, revoked: true } };
        },
      };
    },
  };
}

/** REST 按批次吊销：可用码数量是可变状态，not_found 裁决在 execute。 */
export async function prepareApiInviteRevokeByBatch(
  actor: InviteActor,
  batch: string,
  trace?: ModerationApiTrace,
): Promise<PreparedInviteWrite | InviteDenial> {
  return {
    ok: true,
    async lock(tx) {
      return {
        ok: true as const,
        async execute() {
          const revoked = await applyInviteRevokeByBatch(tx, actor, batch, trace);
          if (revoked === null) return { ok: false as const, code: "not_found" as const };
          return { ok: true as const, data: { batch, revoked } };
        },
      };
    },
  };
}
