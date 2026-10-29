import { randomBytes } from "node:crypto";
import { alias } from "drizzle-orm/mysql-core";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getWebDb, inviteCodes, users } from "@funwind/db";
import { writeAudit, type DbTx } from "@/lib/audit";

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

/** 最近 100 条（含创建人/使用人名）；状态 = 已用 > 已过期 > 可用。保留给旧调用兼容 */
export async function listInvites(): Promise<InviteRow[]> {
  return (await listInvitesPage({ status: "all", page: 1, perPage: 100 })).items;
}

export type InviteStatusFilter = "all" | "available" | "used" | "expired";

export type InvitePageFilters = {
  status: InviteStatusFilter;
  /** 批次关键词（包含匹配） */
  batch?: string;
  page: number;
  perPage?: number;
};

/** 邀请码分页（M9.5）：状态/批次筛选下推 SQL（状态在 SQL 侧用同一套 used/expired 口径表达） */
export async function listInvitesPage(filters: InvitePageFilters): Promise<{
  items: InviteRow[];
  total: number;
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
  const where = conds.length > 0 ? and(...conds) : undefined;

  const creator = alias(users, "invite_creator");
  const usedByUser = alias(users, "invite_used_by");
  const [countRow, rows] = await Promise.all([
    getWebDb()
      .select({ total: sql<number>`COUNT(*)` })
      .from(inviteCodes)
      .where(where),
    getWebDb()
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
      .offset((filters.page - 1) * perPage),
  ]);

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
    total: Number(countRow[0]?.total ?? 0),
  };
}

/** 撤销某批次全部可用码（M9.5 批量撤销）：一条批次级审计（count 进 after）；已用码不受影响 */
export async function revokeInvitesByBatch(
  actor: { userId: number | null; ip?: string | null },
  batch: string,
): Promise<{ ok: true; revoked: number } | { ok: false; code: "not_found" }> {
  const db = getWebDb();
  const result = await db.transaction(async (tx: DbTx) => {
    const out = await tx
      .delete(inviteCodes)
      .where(and(eq(inviteCodes.batch, batch), isNull(inviteCodes.usedAt)));
    const revoked = Number((out as unknown as { affectedRows: number }).affectedRows ?? 0);
    if (revoked === 0) return { ok: false as const, code: "not_found" as const };
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "invite.revoke_batch",
      targetType: "invite_batch",
      targetId: batch,
      after: { revoked },
      ip: actor.ip,
    });
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
  const expiresAt = input.days > 0 ? sql`NOW() + INTERVAL ${input.days} DAY` : null;
  const codes: string[] = [];
  await db.transaction(async (tx: DbTx) => {
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
      after: { count: input.count, days: input.days, codes },
      ip: actor.ip,
    });
  });
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
    await tx.delete(inviteCodes).where(eq(inviteCodes.code, code));
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "invite.revoke",
      targetType: "invite",
      targetId: code,
      before: { batch: row.batch, expiresAt: row.expiresAt },
      ip: actor.ip,
    });
    return { ok: true as const };
  });
  return result;
}
