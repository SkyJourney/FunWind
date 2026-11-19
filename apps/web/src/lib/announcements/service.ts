import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { announcements, getWebDb, insertIdOf } from "@funwind/db";
import { writeAudit, type ConfigActor, type DbTx } from "@/lib/audit";
import { isValidBeijingDateTime, nowBeijingWallTime } from "@/lib/datetime";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import type {
  ModerationApiTrace,
  ModerationWriteDenial,
  PreparedModerationWrite,
} from "@/lib/moderation/contents";

/**
 * 公告管理服务（M20.3 Step 3 从 admin/announcements/actions.ts 抽出）：
 * 创建 / 编辑 / 下线三写与列表、详情两读。后台 Action 与管理 REST 双入口共享
 * lock/apply 内核——审计、条件审计（编辑值未变不写）、announcement.published
 * 事件、startsAt 留空语义完全一致；redirect/revalidatePath 留在 Action 层。
 * 公告无 revision：编辑与下线靠 FOR UPDATE 行锁串行，状态由时间窗派生。
 */

export type AnnouncementDenialCode = "not_found" | "bad_title" | "bad_body" | "bad_window";
type AnnouncementDenial = ModerationWriteDenial<AnnouncementDenialCode>;

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；未登记码由入口兜底 internal）。 */
export const ANNOUNCEMENTS_DENIAL_HTTP = {
  not_found: "not_found",
  bad_title: "bad_request",
  bad_body: "bad_request",
  bad_window: "bad_request",
} as const;

export type AnnouncementFields = {
  title: string;
  bodyMd: string;
  level: "info" | "important";
  audience: "all" | "members";
  showBanner: boolean;
  /** 北京墙面 DATETIME；null = 创建取当前时刻、编辑保留原值 */
  startsAt: string | null;
  /** 北京墙面 DATETIME；null = 长期有效 */
  endsAt: string | null;
};

/** 输入校验（事务外，后台与 REST 共同兜底；表单与 REST zod 先行拦一层）。 */
export function checkAnnouncementFields(
  fields: AnnouncementFields,
): { ok: true } | AnnouncementDenial {
  const title = fields.title.trim();
  if (!title || title.length > 200) return { ok: false, code: "bad_title" };
  if (fields.bodyMd.length > 20_000) return { ok: false, code: "bad_body" };
  for (const value of [fields.startsAt, fields.endsAt]) {
    if (value !== null && !isValidBeijingDateTime(value)) {
      return { ok: false, code: "bad_window" };
    }
  }
  return { ok: true };
}

/** 行锁与状态快照（编辑/下线共用）：保证变更前值与审计记录来自同一事务。 */
type LockedAnnouncement = {
  title: string;
  bodyMd: string;
  level: "info" | "important";
  audience: "all" | "members";
  showBanner: boolean;
  startsAt: string;
  endsAt: string | null;
};

async function lockAnnouncement(
  tx: DbTx,
  id: number,
): Promise<{ ok: true; row: LockedAnnouncement } | { ok: false; code: "not_found" }> {
  const [row] = await tx
    .select({
      title: announcements.title,
      bodyMd: announcements.bodyMd,
      level: announcements.level,
      audience: announcements.audience,
      showBanner: announcements.showBanner,
      startsAt: announcements.startsAt,
      endsAt: announcements.endsAt,
    })
    .from(announcements)
    .where(eq(announcements.id, id))
    .limit(1)
    .for("update");
  if (!row) return { ok: false, code: "not_found" };
  return { ok: true, row };
}

const auditTraceFields = (trace?: ModerationApiTrace) =>
  trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {};

/** 创建执行段（后台与 REST 共享）：插入 + 审计 + published 事件。 */
async function applyAnnouncementCreate(
  tx: DbTx,
  admin: ConfigActor,
  fields: AnnouncementFields,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; announcementId: number; event: EnqueuedEvent }> {
  const values = {
    title: fields.title.trim(),
    bodyMd: fields.bodyMd,
    level: fields.level,
    audience: fields.audience,
    showBanner: fields.showBanner,
    startsAt: fields.startsAt ?? nowBeijingWallTime(),
    endsAt: fields.endsAt,
    createdBy: admin.userId ?? 0,
  };
  const announcementId = insertIdOf(
    await tx.insert(announcements).values({
      ...values,
      createdAt: nowBeijingWallTime(),
      updatedAt: nowBeijingWallTime(),
    }),
  );
  await writeAudit(tx, {
    actorId: admin.userId ?? null,
    action: "announcement.create",
    targetType: "announcement",
    targetId: announcementId,
    before: null,
    after: { ...values, via: admin.via, ...auditTraceFields(trace) },
    ip: admin.ip,
  });
  const event = await enqueueEventInTx(
    tx,
    "announcement.published",
    { announcementId, createdBy: admin.userId ?? 0 },
    { actorId: admin.userId ?? undefined, source: "admin" },
  );
  return { ok: true, announcementId, event };
}

/** 编辑执行段（后台与 REST 共享）：startsAt 留空保留原值；值未变不写审计、不重发 published。 */
async function applyAnnouncementEdit(
  tx: DbTx,
  admin: ConfigActor,
  id: number,
  fields: AnnouncementFields,
  orig: LockedAnnouncement,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; changed: boolean }> {
  const values = {
    title: fields.title.trim(),
    bodyMd: fields.bodyMd,
    level: fields.level,
    audience: fields.audience,
    showBanner: fields.showBanner,
    startsAt: fields.startsAt ?? orig.startsAt,
    endsAt: fields.endsAt,
  };
  await tx
    .update(announcements)
    .set({ ...values, updatedAt: nowBeijingWallTime() })
    .where(eq(announcements.id, id));
  const changed = JSON.stringify(orig) !== JSON.stringify(values);
  if (changed) {
    await writeAudit(tx, {
      actorId: admin.userId ?? null,
      action: "announcement.edit",
      targetType: "announcement",
      targetId: id,
      before: orig,
      after: { ...values, via: admin.via, ...auditTraceFields(trace) },
      ip: admin.ip,
    });
  }
  return { ok: true, changed };
}

/** 下线执行段（后台与 REST 共享）：ends_at 置当前时刻 + 审计。 */
async function applyAnnouncementEnd(
  tx: DbTx,
  admin: ConfigActor,
  id: number,
  orig: LockedAnnouncement,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; endsAt: string }> {
  const endedAt = nowBeijingWallTime();
  await tx
    .update(announcements)
    .set({ endsAt: endedAt, updatedAt: endedAt })
    .where(eq(announcements.id, id));
  await writeAudit(tx, {
    actorId: admin.userId ?? null,
    action: "announcement.end",
    targetType: "announcement",
    targetId: id,
    before: { endsAt: orig.endsAt },
    after: { endsAt: endedAt, via: admin.via, ...auditTraceFields(trace) },
    ip: admin.ip,
  });
  return { ok: true, endsAt: endedAt };
}

// ------------------------------------------------------------
// 后台入口（一次性写；Action 负责 redirect/revalidatePath）
// ------------------------------------------------------------

export async function createAnnouncement(
  admin: ConfigActor,
  fields: AnnouncementFields,
): Promise<{ ok: true; announcementId: number }> {
  const checked = checkAnnouncementFields(fields);
  if (!checked.ok) throw new Error(`公告输入不合法：${checked.code}`);
  let announcementId = 0;
  let event: EnqueuedEvent | null = null;
  await getWebDb().transaction(async (tx) => {
    const applied = await applyAnnouncementCreate(tx, admin, fields);
    announcementId = applied.announcementId;
    event = applied.event;
  }, POINTS_TX_OPTIONS);
  if (event) await dispatchOutboxRows([event]);
  await sweepPending();
  return { ok: true, announcementId };
}

export async function editAnnouncement(
  admin: ConfigActor,
  id: number,
  fields: AnnouncementFields,
): Promise<{ ok: true; changed: boolean } | { ok: false; code: "not_found" }> {
  const checked = checkAnnouncementFields(fields);
  if (!checked.ok) throw new Error(`公告输入不合法：${checked.code}`);
  return withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const locked = await lockAnnouncement(tx, id);
      if (!locked.ok) return locked;
      return applyAnnouncementEdit(tx, admin, id, fields, locked.row);
    }),
  );
}

export async function endAnnouncement(
  admin: ConfigActor,
  id: number,
): Promise<{ ok: true; endsAt: string } | { ok: false; code: "not_found" }> {
  return getWebDb().transaction(async (tx) => {
    const locked = await lockAnnouncement(tx, id);
    if (!locked.ok) return locked;
    return applyAnnouncementEnd(tx, admin, id, locked.row);
  });
}

// ------------------------------------------------------------
// REST 写变体（prepare/lock/execute；合法回放已被幂等缓存短路）
// ------------------------------------------------------------

export type PreparedAnnouncementWrite = PreparedModerationWrite<
  { announcementId: number; changed?: boolean; endsAt?: string },
  AnnouncementDenialCode
>;

/** REST 创建公告：输入校验在 prepare（事务外）；published 事件 afterCommit 快派。 */
export async function prepareApiAnnouncementCreate(
  admin: ConfigActor,
  fields: AnnouncementFields,
  trace?: ModerationApiTrace,
): Promise<PreparedAnnouncementWrite | AnnouncementDenial> {
  const checked = checkAnnouncementFields(fields);
  if (!checked.ok) return checked;
  return {
    ok: true,
    async lock(tx) {
      // 创建无行锁目标；insert 幂等由缓存回放承担，新意图直接执行
      return {
        ok: true,
        async execute() {
          const applied = await applyAnnouncementCreate(tx, admin, fields, trace);
          return {
            ok: true as const,
            data: { announcementId: applied.announcementId },
            async afterCommit() {
              await dispatchOutboxRows([applied.event]);
              await sweepPending();
            },
          };
        },
      };
    },
  };
}

/** REST 编辑公告：存在性在锁段；值未变的条件审计在执行段。 */
export async function prepareApiAnnouncementEdit(
  admin: ConfigActor,
  id: number,
  fields: AnnouncementFields,
  trace?: ModerationApiTrace,
): Promise<PreparedAnnouncementWrite | AnnouncementDenial> {
  const checked = checkAnnouncementFields(fields);
  if (!checked.ok) return checked;
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockAnnouncement(tx, id);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          const applied = await applyAnnouncementEdit(tx, admin, id, fields, locked.row, trace);
          return {
            ok: true as const,
            data: { announcementId: id, changed: applied.changed },
          };
        },
      };
    },
  };
}

/** REST 下线公告：存在性在锁段；ends_at 置当前时刻。 */
export async function prepareApiAnnouncementEnd(
  admin: ConfigActor,
  id: number,
  trace?: ModerationApiTrace,
): Promise<PreparedAnnouncementWrite | AnnouncementDenial> {
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockAnnouncement(tx, id);
      if (!locked.ok) return locked;
      return {
        ok: true,
        async execute() {
          const applied = await applyAnnouncementEnd(tx, admin, id, locked.row, trace);
          return {
            ok: true as const,
            data: { announcementId: id, endsAt: applied.endsAt },
          };
        },
      };
    },
  };
}

// ------------------------------------------------------------
// 管理读（列表/详情；后台页面仍用其内联查询，本组函数供管理 REST 使用）
// ------------------------------------------------------------

export type AnnouncementStatus = "scheduled" | "active" | "ended";

export type AdminAnnouncementListItem = {
  id: number;
  title: string;
  level: "info" | "important";
  audience: "all" | "members";
  showBanner: boolean;
  startsAt: string;
  endsAt: string | null;
  /** 时间窗派生状态：窗口未开始 = scheduled；已过 endsAt = ended；其余 = active */
  status: AnnouncementStatus;
  createdAt: string;
};

const statusOf = (startsAt: string, endsAt: string | null): AnnouncementStatus => {
  const now = nowBeijingWallTime();
  if (startsAt > now) return "scheduled";
  if (endsAt !== null && endsAt <= now) return "ended";
  return "active";
};

/** 管理视角公告列表：全状态可见，标题 LIKE 与状态筛选，分页口径与其余管理列表一致。 */
export async function listAnnouncementsPage(filters: {
  q?: string;
  status?: AnnouncementStatus;
  page: number;
  perPage?: number;
}): Promise<{
  items: AdminAnnouncementListItem[];
  total: number;
  page: number;
  totalPages: number;
}> {
  const perPage = filters.perPage ?? 20;
  const conds = [];
  const q = filters.q?.trim();
  if (q) conds.push(sql`${announcements.title} LIKE ${`%${q}%`}`);
  if (filters.status === "scheduled") conds.push(sql`${announcements.startsAt} > NOW()`);
  if (filters.status === "active") {
    conds.push(
      sql`${announcements.startsAt} <= NOW() AND (${announcements.endsAt} IS NULL OR ${announcements.endsAt} > NOW())`,
    );
  }
  if (filters.status === "ended") {
    conds.push(sql`${announcements.endsAt} IS NOT NULL AND ${announcements.endsAt} <= NOW()`);
  }
  const where = conds.length > 0 ? and(...conds) : undefined;
  const base = getWebDb();
  const [countRow] = await base
    .select({ total: sql<number>`COUNT(*)` })
    .from(announcements)
    .where(where);
  const total = Number(countRow?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, filters.page), totalPages);
  const rows = await base
    .select({
      id: announcements.id,
      title: announcements.title,
      level: announcements.level,
      audience: announcements.audience,
      showBanner: announcements.showBanner,
      startsAt: announcements.startsAt,
      endsAt: announcements.endsAt,
      createdAt: announcements.createdAt,
    })
    .from(announcements)
    .where(where)
    .orderBy(desc(announcements.createdAt), asc(announcements.id))
    .limit(perPage)
    .offset((page - 1) * perPage);
  return {
    items: rows.map((row) => ({ ...row, status: statusOf(row.startsAt, row.endsAt) })),
    total,
    page,
    totalPages,
  };
}

/** 管理视角公告详情：全行可见；不存在返回 null。 */
export async function loadAnnouncementDetail(id: number) {
  const [row] = await getWebDb()
    .select()
    .from(announcements)
    .where(eq(announcements.id, id))
    .limit(1);
  if (!row) return null;
  return { ...row, status: statusOf(row.startsAt, row.endsAt) };
}
