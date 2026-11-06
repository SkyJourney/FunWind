import "server-only";

import { eq } from "drizzle-orm";
import { campaigns, getWebDb, insertIdOf } from "@funwind/db";
import { writeAudit, type ConfigActor, type DbTx } from "@/lib/audit";
import { invalidateSiteChrome } from "@/lib/chrome/site-chrome";
import { nowBeijingWallTime } from "@/lib/datetime";
import { findCampaignEffect } from "./effects";
import { validateCampaignFields, type CampaignFields, type CampaignInputError } from "./input";
import { campaignRefExists } from "./refs";

/**
 * 运营排期写服务（M11.2）：新建 / 编辑 / 启停 / 删除。
 * 约定与主题包写服务一致：事务内写审计（动作回滚则审计一并回滚）、revision 乐观锁、
 * 提交后失效站点框架缓存，使后台保存在同进程内即时生效。
 * 连接池只有 8 条：引用校验（读库）一律在开事务前完成，事务内不再借第二条连接。
 */

export type CampaignErrorCode = CampaignInputError | "missing-ref" | "not-found" | "conflict";

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

/** 输入校验 + 引用存在性校验（读库，必须在事务外）
 * M11.2 三个 select effect（theme.pack / site.logo / site.hero）需要检查引用存在性；
 * M11.4+ 新 effect（无参数或数值参数）无外键，跳过引用检查。
 */
async function prepare(fields: CampaignFields) {
  const checked = validateCampaignFields(fields);
  if (!checked.ok) return checked;

  // 根据 effect 的字段类型判断是否需要检查引用存在性
  const effect = findCampaignEffect(checked.value.effect);
  if (effect?.field.type === "select") {
    // M11.2 select effect 需要检查目标引用是否存在
    const target = fields.target?.trim() ?? "";
    if (!(await campaignRefExists(checked.value.effect, target))) {
      return { ok: false as const, code: "missing-ref" as const };
    }
  }
  // 其他 effect 类型（none、number）无外键，无需检查

  return checked;
}

export async function createCampaign(
  fields: CampaignFields,
  actor: ConfigActor,
): Promise<CampaignResult> {
  const checked = await prepare(fields);
  if (!checked.ok) return checked;
  const now = nowBeijingWallTime();
  const id = await getWebDb().transaction(async (tx) => {
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
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "campaign.create",
      targetType: "campaign",
      targetId: newId,
      before: null,
      after: { ...checked.value, enabled: true, revision: 1, via: actor.via },
      ip: actor.ip,
    });
    return newId;
  });
  invalidateSiteChrome();
  return { ok: true, value: { id } };
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
  const result = await getWebDb().transaction(async (tx) => {
    const row = await lockCampaign(tx, id);
    if (!row) return { ok: false as const, code: "not-found" as const };
    if (row.revision !== expectedRevision) return { ok: false as const, code: "conflict" as const };
    const revision = row.revision + 1;
    await tx
      .update(campaigns)
      .set({ ...checked.value, revision, updatedAt: nowBeijingWallTime() })
      .where(eq(campaigns.id, id));
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "campaign.update",
      targetType: "campaign",
      targetId: id,
      before: snapshot(row),
      after: { ...checked.value, enabled: row.enabled, revision, via: actor.via },
      ip: actor.ip,
    });
    return { ok: true as const, value: { id } };
  });
  if (result.ok) invalidateSiteChrome();
  return result;
}

/** 启停：旁路写同样 revision+1，使打开着的编辑页下次提交能感知并发（G-20） */
export async function setCampaignEnabled(
  id: number,
  enabled: boolean,
  actor: ConfigActor,
): Promise<CampaignResult> {
  const result = await getWebDb().transaction(async (tx) => {
    const row = await lockCampaign(tx, id);
    if (!row) return { ok: false as const, code: "not-found" as const };
    if (row.enabled === enabled) return { ok: true as const, value: { id } };
    const revision = row.revision + 1;
    await tx
      .update(campaigns)
      .set({ enabled, revision, updatedAt: nowBeijingWallTime() })
      .where(eq(campaigns.id, id));
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "campaign.toggle",
      targetType: "campaign",
      targetId: id,
      before: { enabled: row.enabled, revision: row.revision },
      after: { enabled, revision, via: actor.via },
      ip: actor.ip,
    });
    return { ok: true as const, value: { id } };
  });
  if (result.ok) invalidateSiteChrome();
  return result;
}

/** 删除：物理删除；方案本身无下游引用，删除即时回退到常态读取链 */
export async function deleteCampaign(id: number, actor: ConfigActor): Promise<CampaignResult> {
  const result = await getWebDb().transaction(async (tx) => {
    const row = await lockCampaign(tx, id);
    if (!row) return { ok: false as const, code: "not-found" as const };
    await tx.delete(campaigns).where(eq(campaigns.id, id));
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "campaign.delete",
      targetType: "campaign",
      targetId: id,
      before: snapshot(row),
      after: null,
      ip: actor.ip,
    });
    return { ok: true as const, value: { id } };
  });
  if (result.ok) invalidateSiteChrome();
  return result;
}
