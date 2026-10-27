import { randomBytes } from "node:crypto";
import { alias } from "drizzle-orm/mysql-core";
import { desc, eq, sql } from "drizzle-orm";
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

/** 最近 100 条（含创建人/使用人名）；状态 = 已用 > 已过期 > 可用 */
export async function listInvites(): Promise<InviteRow[]> {
  const creator = alias(users, "invite_creator");
  const usedByUser = alias(users, "invite_used_by");
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
    .orderBy(desc(inviteCodes.createdAt))
    .limit(100);
  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    status:
      r.usedAt !== null
        ? "used"
        : r.expiresAt !== null && ts(r.expiresAt) <= now
          ? "expired"
          : "available",
  }));
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
