import "server-only";

import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { campaigns, getWebDb, insertIdOf } from "@funwind/db";
import { writeAudit, type ConfigActor, type DbTx } from "@/lib/audit";
import { invalidateSiteChrome } from "@/lib/chrome/site-chrome";
import { nowBeijingWallTime } from "@/lib/datetime";
import { withDeadlockRetry } from "@/lib/points/retry";
import type {
  ModerationApiTrace,
  ModerationWriteDenial,
  PreparedModerationWrite,
} from "@/lib/moderation/contents";
import { findCampaignEffect } from "./effects";
import { validateCampaignFields, type CampaignFields, type CampaignInputError } from "./input";
import { campaignRefExists } from "./refs";
import { intersects, type CampaignWindow } from "./status";

/**
 * 运营排期写服务（M11.2）：新建 / 编辑 / 启停 / 删除。
 * 约定与主题包写服务一致：事务内写审计（动作回滚则审计一并回滚）、revision 乐观锁、
 * 提交后失效站点框架缓存，使后台保存在同进程内即时生效。
 * 连接池只有 8 条：引用校验（读库）一律在开事务前完成，事务内不再借第二条连接。
 * M11.4：行为类方案的时间窗重叠拒绝（Q5）在事务内加锁读完成（见 behaviorOverlapExists）；
 * 新建 / 编辑 / 启停三个写事务统一外包 withDeadlockRetry——两路并发保存靠间隙锁串行化或死锁重试收敛。
 */

export type CampaignErrorCode =
  CampaignInputError | "missing-ref" | "not-found" | "conflict" | "overlap";

export type CampaignResult<T = { id: number }> =
  { ok: true; value: T } | { ok: false; code: CampaignErrorCode };

/** 审计里记录的方案快照（不含 revision 之外的内部列） */
function snapshot(row: typeof campaigns.$inferSelect) {
  return {
    name: row.name,
    effect: row.effect,
    config: row.config,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    enabled: row.enabled,
    priority: row.priority,
    revision: row.revision,
  };
}

async function lockCampaign(tx: DbTx, id: number) {
  const [row] = await tx
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .limit(1)
    .for("update");
  return row ?? null;
}

/** 排期审计的固定脚手架：targetType 恒为 campaign，via 由这里统一附加（四个写动作共用） */
async function writeCampaignAudit(
  tx: DbTx,
  actor: ConfigActor,
  action: string,
  targetId: number,
  before: unknown,
  afterPayload: Record<string, unknown> | null,
) {
  await writeAudit(tx, {
    actorId: actor.userId,
    action,
    targetType: "campaign",
    targetId,
    before,
    after: afterPayload === null ? null : { ...afterPayload, via: actor.via },
    ip: actor.ip,
  });
}

/** 输入校验 + 引用存在性校验（读库，必须在事务外） */
async function prepare(fields: CampaignFields) {
  const checked = validateCampaignFields(fields);
  if (!checked.ok) return checked;
  if (!(await campaignRefExists(checked.value.effect, fields.target.trim()))) {
    return { ok: false as const, code: "missing-ref" as const };
  }
  return checked;
}

/**
 * 行为类方案的时间窗重叠检查（M11.4 Q5 / D4，§2.2 F7）：必须在**写事务内**对同 effect 的启用行加锁读
 * （FOR UPDATE，排除自身），用 status.ts 的半开区间相交判定（首尾相接不算相交）。
 * 事务保持默认 REPEATABLE READ：按 effect 范围的加锁读带间隙锁，两路并发保存要么串行化
 * （后者看到先提交的行 → overlap），要么死锁由 withDeadlockRetry 重试后看到对方已提交的行 →
 * 最终恰好一个成功；换成 READ COMMITTED 会失去间隙锁，并发保存可双双通过，禁止改。
 * 只比较「启用中且未结束」的同类行为方案（D4 + 半开窗口语义）：停用方案不参与，重新启用时（setCampaignEnabled）
 * 再查；已结束的窗口不会再生效，与它重叠的新窗口应当放行（ends_at > NOW() 过滤，与读取链同口径）。
 * kind 判断折进本函数：视觉类（或停用态）直接返回 false——重叠合法，由 priority 选优。
 */
async function behaviorOverlapExists(
  tx: DbTx,
  effect: string,
  self: { id?: number; startsAt: string; endsAt: string | null },
  /** 保存后该方案是否处于启用态（create 恒为 true；update 看原行；toggle 看目标状态） */
  activeAfterSave: boolean,
): Promise<boolean> {
  if (!activeAfterSave || findCampaignEffect(effect)?.kind !== "behavior") return false;
  const rows = await tx
    .select({
      id: campaigns.id,
      effect: campaigns.effect,
      enabled: campaigns.enabled,
      startsAt: campaigns.startsAt,
      endsAt: campaigns.endsAt,
      priority: campaigns.priority,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.effect, effect),
        eq(campaigns.enabled, true),
        or(isNull(campaigns.endsAt), gt(campaigns.endsAt, sql`NOW()`)),
      ),
    )
    .for("update");
  const window: CampaignWindow = {
    id: self.id ?? -1,
    effect,
    enabled: true,
    startsAt: self.startsAt,
    endsAt: self.endsAt,
    priority: 0,
  };
  return rows.some((row) => row.id !== window.id && intersects(row, window));
}

/** 按名称与 effect 精确查找方案（M14 节日装扮 create-if-absent 的幂等键：规则·年 × effect）。 */
export async function findCampaignByNameAndEffect(
  name: string,
  effect: string,
): Promise<typeof campaigns.$inferSelect | null> {
  const [row] = await getWebDb()
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.name, name), eq(campaigns.effect, effect)))
    .limit(1);
  return row ?? null;
}

export async function createCampaign(
  fields: CampaignFields,
  actor: ConfigActor,
): Promise<CampaignResult> {
  const checked = await prepare(fields);
  if (!checked.ok) return checked;
  const now = nowBeijingWallTime();
  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<CampaignResult> => {
      if (
        await behaviorOverlapExists(
          tx,
          checked.value.effect,
          {
            startsAt: checked.value.startsAt,
            endsAt: checked.value.endsAt,
          },
          true,
        )
      ) {
        return { ok: false as const, code: "overlap" as const };
      }
      const newId = insertIdOf(
        await tx.insert(campaigns).values({
          ...checked.value,
          enabled: true,
          revision: 1,
          createdBy: actor.userId,
          createdAt: now,
          updatedAt: now,
        }),
      );
      await writeCampaignAudit(tx, actor, "campaign.create", newId, null, {
        ...checked.value,
        enabled: true,
        revision: 1,
      });
      return { ok: true as const, value: { id: newId } };
    }),
  );
  if (result.ok) invalidateSiteChrome();
  return result;
}

/** 编辑：revision 与库内不一致 → conflict（不覆盖他人改动，也不静默换用最新版本） */
export async function updateCampaign(
  id: number,
  expectedRevision: number,
  fields: CampaignFields,
  actor: ConfigActor,
): Promise<CampaignResult> {
  const checked = await prepare(fields);
  if (!checked.ok) return checked;
  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<CampaignResult> => {
      const row = await lockCampaign(tx, id);
      if (!row) return { ok: false as const, code: "not-found" as const };
      if (row.revision !== expectedRevision)
        return { ok: false as const, code: "conflict" as const };
      // 编辑不改变启停状态：保存后仍启用的行为类方案同样不得与他人时间重叠（编辑自身已排除）
      if (
        await behaviorOverlapExists(
          tx,
          checked.value.effect,
          {
            id,
            startsAt: checked.value.startsAt,
            endsAt: checked.value.endsAt,
          },
          row.enabled,
        )
      ) {
        return { ok: false as const, code: "overlap" as const };
      }
      const revision = row.revision + 1;
      await tx
        .update(campaigns)
        .set({ ...checked.value, revision, updatedAt: nowBeijingWallTime() })
        .where(eq(campaigns.id, id));
      await writeCampaignAudit(tx, actor, "campaign.update", id, snapshot(row), {
        ...checked.value,
        enabled: row.enabled,
        revision,
      });
      return { ok: true as const, value: { id } };
    }),
  );
  if (result.ok) invalidateSiteChrome();
  return result;
}

/** 启停：旁路写同样 revision+1，使打开着的编辑页下次提交能感知并发（G-20）；
 * 行为类方案重新启用（D4）时与其他启用中的同类方案重叠 → overlap */
export async function setCampaignEnabled(
  id: number,
  enabled: boolean,
  actor: ConfigActor,
): Promise<CampaignResult> {
  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<CampaignResult> => {
      const row = await lockCampaign(tx, id);
      if (!row) return { ok: false as const, code: "not-found" as const };
      if (row.enabled === enabled) return { ok: true as const, value: { id } };
      if (
        await behaviorOverlapExists(
          tx,
          row.effect,
          {
            id,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
          },
          enabled,
        )
      ) {
        return { ok: false as const, code: "overlap" as const };
      }
      const revision = row.revision + 1;
      await tx
        .update(campaigns)
        .set({ enabled, revision, updatedAt: nowBeijingWallTime() })
        .where(eq(campaigns.id, id));
      await writeCampaignAudit(
        tx,
        actor,
        "campaign.toggle",
        id,
        { enabled: row.enabled, revision: row.revision },
        { enabled, revision },
      );
      return { ok: true as const, value: { id } };
    }),
  );
  if (result.ok) invalidateSiteChrome();
  return result;
}

/** 删除：物理删除；方案本身无下游引用，删除即时回退到常态读取链 */
export async function deleteCampaign(id: number, actor: ConfigActor): Promise<CampaignResult> {
  const result = await getWebDb().transaction(async (tx) => {
    const row = await lockCampaign(tx, id);
    if (!row) return { ok: false as const, code: "not-found" as const };
    await tx.delete(campaigns).where(eq(campaigns.id, id));
    await writeCampaignAudit(tx, actor, "campaign.delete", id, snapshot(row), null);
    return { ok: true as const, value: { id } };
  });
  if (result.ok) invalidateSiteChrome();
  return result;
}

// ============================================================
// REST 写变体（M20.3 Step 3）：prepare/lock/execute 三段式，与后台入口共享
// prepare（输入+引用校验）/ lockCampaign / behaviorOverlapExists / 审计脚手架。
// execute 运行在幂等管线的外层事务内（闭包捕获 lock 的 tx，不再另开事务），
// 幂等占位与业务写入同事务提交；revision 冲突与 overlap 等可变状态裁决在 execute，
// 合法回放已被缓存短路，不会重复写。
// ============================================================

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；未登记码由入口兜底 internal）。 */
export const CAMPAIGNS_DENIAL_HTTP = {
  "bad-name": "bad_request",
  "bad-effect": "bad_request",
  "bad-target": "bad_request",
  "bad-start": "bad_request",
  "bad-end": "bad_request",
  "bad-window": "bad_request",
  "bad-priority": "bad_request",
  "missing-ref": "bad_request",
  "not-found": "not_found",
  conflict: "state_conflict",
  overlap: "state_conflict",
} as const;

/** REST 审计的 API 追踪字段（仅传入 trace 时附加，后台审计形态不变）。 */
const campaignTraceFields = (trace?: ModerationApiTrace) =>
  trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {};

export type PreparedCampaignWrite = PreparedModerationWrite<
  { id: number; revision?: number; enabled?: boolean; changed?: boolean },
  CampaignErrorCode
>;

/** REST 创建活动：输入与引用校验在 prepare（事务外）；overlap 裁决与写入在 execute。 */
export async function prepareApiCampaignCreate(
  fields: CampaignFields,
  actor: ConfigActor,
  trace?: ModerationApiTrace,
): Promise<PreparedCampaignWrite | ModerationWriteDenial<CampaignErrorCode>> {
  const checked = await prepare(fields);
  if (!checked.ok) return checked;
  return {
    ok: true,
    async lock(tx) {
      // 创建无行锁目标；overlap 依赖事务内间隙锁读，归入 execute（同一事务）
      return {
        ok: true as const,
        async execute() {
          if (
            await behaviorOverlapExists(
              tx,
              checked.value.effect,
              { startsAt: checked.value.startsAt, endsAt: checked.value.endsAt },
              true,
            )
          ) {
            return { ok: false as const, code: "overlap" as const };
          }
          const now = nowBeijingWallTime();
          const newId = insertIdOf(
            await tx.insert(campaigns).values({
              ...checked.value,
              enabled: true,
              revision: 1,
              createdBy: actor.userId,
              createdAt: now,
              updatedAt: now,
            }),
          );
          await writeCampaignAudit(tx, actor, "campaign.create", newId, null, {
            ...checked.value,
            enabled: true,
            revision: 1,
            ...campaignTraceFields(trace),
          });
          return {
            ok: true as const,
            data: { id: newId, revision: 1 },
            async afterCommit() {
              invalidateSiteChrome();
            },
          };
        },
      };
    },
  };
}

/** REST 编辑活动：存在性在锁段；revision 冲突与 overlap 裁决在 execute（回放短路后不再误拒）。 */
export async function prepareApiCampaignUpdate(
  id: number,
  expectedRevision: number,
  fields: CampaignFields,
  actor: ConfigActor,
  trace?: ModerationApiTrace,
): Promise<PreparedCampaignWrite | ModerationWriteDenial<CampaignErrorCode>> {
  const checked = await prepare(fields);
  if (!checked.ok) return checked;
  return {
    ok: true,
    async lock(tx) {
      const row = await lockCampaign(tx, id);
      if (!row) return { ok: false as const, code: "not-found" as const };
      return {
        ok: true as const,
        async execute() {
          // 锁内行快照（lock 段的 FOR UPDATE 行锁在本事务内持续持有）
          if (row.revision !== expectedRevision) {
            return { ok: false as const, code: "conflict" as const };
          }
          if (
            await behaviorOverlapExists(
              tx,
              checked.value.effect,
              { id, startsAt: checked.value.startsAt, endsAt: checked.value.endsAt },
              row.enabled,
            )
          ) {
            return { ok: false as const, code: "overlap" as const };
          }
          const revision = row.revision + 1;
          await tx
            .update(campaigns)
            .set({ ...checked.value, revision, updatedAt: nowBeijingWallTime() })
            .where(eq(campaigns.id, id));
          await writeCampaignAudit(tx, actor, "campaign.update", id, snapshot(row), {
            ...checked.value,
            enabled: row.enabled,
            revision,
            ...campaignTraceFields(trace),
          });
          return {
            ok: true as const,
            data: { id, revision },
            async afterCommit() {
              invalidateSiteChrome();
            },
          };
        },
      };
    },
  };
}

/** REST 启停活动：同值幂等返回 changed:false（旁路写仍 revision+1 的 G-20 语义保持）。 */
export async function prepareApiCampaignEnabled(
  id: number,
  enabled: boolean,
  actor: ConfigActor,
  trace?: ModerationApiTrace,
): Promise<PreparedCampaignWrite | ModerationWriteDenial<CampaignErrorCode>> {
  return {
    ok: true,
    async lock(tx) {
      const row = await lockCampaign(tx, id);
      if (!row) return { ok: false as const, code: "not-found" as const };
      return {
        ok: true as const,
        async execute() {
          if (row.enabled === enabled) {
            return {
              ok: true as const,
              data: { id, revision: row.revision, enabled, changed: false },
            };
          }
          if (
            await behaviorOverlapExists(
              tx,
              row.effect,
              { id, startsAt: row.startsAt, endsAt: row.endsAt },
              enabled,
            )
          ) {
            return { ok: false as const, code: "overlap" as const };
          }
          const revision = row.revision + 1;
          await tx
            .update(campaigns)
            .set({ enabled, revision, updatedAt: nowBeijingWallTime() })
            .where(eq(campaigns.id, id));
          await writeCampaignAudit(
            tx,
            actor,
            "campaign.toggle",
            id,
            { enabled: row.enabled, revision: row.revision },
            { enabled, revision, ...campaignTraceFields(trace) },
          );
          return {
            ok: true as const,
            data: { id, revision, enabled, changed: true },
            async afterCommit() {
              invalidateSiteChrome();
            },
          };
        },
      };
    },
  };
}
