import { and, eq, inArray, sql } from "drizzle-orm";
import { gateUnlocks, postGates } from "@funwind/db";
import type { GateCondition, GateDraft, GateMatchMode } from "@funwind/content";
import type { DbExecutor } from "@/lib/audit";
import { gatesWithAttachments } from "./attachments";

/**
 * 门控写入器（M6.1，设计见 docs/milestones/M6.1-write-path.md §7 与 docs/GATES.md §2）。
 *
 * **只写不读隐藏正文**：隐藏正文只有 lib/gates/service.ts 能读取（硬约定 3b，hidden-md-guard 守护）。本文件因为要写
 * post_gates.hidden_md 而进入守卫白名单，但承诺只出不进——查询一律显式列字段、绝不取 hidden_md，结果与错误信息也不含隐藏文本
 * （write.test.ts 守护）。
 *
 * 做的事：把"保存时拆出来的门控草稿"与库里该帖已有的门控按 gate_key 对账，得到 新增 / 更新 / 删除 三组，校验后落库。
 * 校验（任一失败整体拒绝，调用方回滚事务）：
 *  · 权限：新增门控、或改了条件的门控，需要作者持有对应创建权限（points → gate.points，reply → gate.reply）。
 *    **没改条件的既有门控不要求**——权限被收回后，作者仍能编辑帖子里别的内容，不会被一个旧门控卡死。
 *  · 已有解锁记录的门控：不可删除；条件只允许改价格（仍是单个 points 条件、匹配模式不变）——改价不退款，只影响之后的购买
 *    （GATES.md §2）；改成别的条件类型会让已付费的买家莫名失去依据，一律拒绝。
 *  · 名下还挂着附件（attachments.gate_id）的门控不可删除：必须先重新指派附件（M6.4 的交互），不得静默让附件变公开。
 */

export type GateWriteErrorCode =
  | "gate_permission" // 没有创建该类门控的权限
  | "gate_has_unlocks" // 已有解锁记录，不可删除
  | "gate_conditions_locked" // 已有解锁记录，只允许改价格
  | "gate_has_attachments"; // 名下还有附件，不可删除

export interface GateWriteError {
  code: GateWriteErrorCode;
  /** 出错的门控 key */
  gateKey: string;
  message: string;
}

/** 库里已有的门控（不含隐藏正文） */
export interface ExistingGate {
  id: number;
  gateKey: string;
  conditions: GateCondition[];
  matchMode: GateMatchMode;
  /** 是否已有解锁记录（以 gate_unlocks 为准） */
  hasUnlocks: boolean;
  /** 名下是否还挂着附件 */
  hasAttachments: boolean;
}

export interface GatePermissions {
  /** gate.points：创建积分购买型门控 */
  points: boolean;
  /** gate.reply：创建回复可见型门控 */
  reply: boolean;
}

export interface GatePlan {
  inserts: GateDraft[];
  updates: { id: number; draft: GateDraft }[];
  deletes: { id: number; gateKey: string }[];
}

const permissionOfOne = (c: GateCondition, p: GatePermissions): boolean =>
  c.type === "points" ? p.points : c.type === "reply" ? p.reply : false;

/**
 * 作者是否有权创建这组条件：**每一个**条件都要有对应权限，空条件与未知类型一律拒绝。
 * 目前 splitSource 只会产出单条件门控，但这里的入参类型允许任意草稿——权限检查不能依赖上游的这个巧合
 * （自动安全审查指出过只看第一个条件的漏洞：`[reply, points]` 会只按 reply 放行）。
 */
const permitted = (conditions: readonly GateCondition[], p: GatePermissions): boolean =>
  conditions.length > 0 && conditions.every((c) => permissionOfOne(c, p));

/** 条件是否"相同"：忽略键顺序 */
const sameConditions = (a: GateCondition[], b: GateCondition[]): boolean =>
  JSON.stringify(a.map(sortKeys)) === JSON.stringify(b.map(sortKeys));
const sortKeys = (c: GateCondition): GateCondition =>
  Object.fromEntries(Object.entries(c).sort(([x], [y]) => x.localeCompare(y))) as GateCondition;

/** 有解锁记录的门控，条件变化是否只是价格：仍是单个 points 条件，且只有 price 不同 */
function onlyPriceChanged(
  before: ExistingGate,
  after: Pick<GateDraft, "conditions" | "matchMode">,
): boolean {
  if (before.matchMode !== after.matchMode) return false;
  if (before.conditions.length !== 1 || after.conditions.length !== 1) return false;
  const [b, a] = [before.conditions[0]!, after.conditions[0]!];
  if (b.type !== "points" || a.type !== "points") return false;
  const { price: _bp, ...bRest } = b;
  const { price: _ap, ...aRest } = a;
  void _bp;
  void _ap;
  return (
    JSON.stringify(sortKeys(bRest as GateCondition)) ===
    JSON.stringify(sortKeys(aRest as GateCondition))
  );
}

/** 纯函数：对账并校验。草稿的 key 必须已由 splitSource 分配好 */
export function planGateChanges(
  existing: readonly ExistingGate[],
  drafts: readonly GateDraft[],
  perms: GatePermissions,
): { ok: true; plan: GatePlan } | { ok: false; error: GateWriteError } {
  const byKey = new Map(existing.map((g) => [g.gateKey, g]));
  const draftKeys = new Set(drafts.map((d) => d.key));
  const plan: GatePlan = { inserts: [], updates: [], deletes: [] };

  for (const g of existing) {
    if (draftKeys.has(g.gateKey)) continue;
    if (g.hasUnlocks) {
      return fail(
        "gate_has_unlocks",
        g.gateKey,
        "该门控已有人解锁，不能删除（可以修改内容或价格）",
      );
    }
    if (g.hasAttachments) {
      return fail(
        "gate_has_attachments",
        g.gateKey,
        "该门控名下还有附件，请先重新指派附件再删除门控",
      );
    }
    plan.deletes.push({ id: g.id, gateKey: g.gateKey });
  }

  for (const d of drafts) {
    const prev = byKey.get(d.key);
    if (!prev) {
      if (!permitted(d.conditions, perms)) {
        return fail("gate_permission", d.key, "你没有创建这类门控的权限");
      }
      plan.inserts.push(d);
      continue;
    }
    const conditionsChanged =
      prev.matchMode !== d.matchMode || !sameConditions(prev.conditions, d.conditions);
    if (conditionsChanged) {
      if (prev.hasUnlocks && !onlyPriceChanged(prev, d)) {
        return fail(
          "gate_conditions_locked",
          d.key,
          "该门控已有人解锁，只能修改价格，不能更换解锁方式",
        );
      }
      if (!permitted(d.conditions, perms)) {
        return fail("gate_permission", d.key, "你没有创建这类门控的权限");
      }
    }
    plan.updates.push({ id: prev.id, draft: d });
  }
  return { ok: true, plan };
}

const fail = (code: GateWriteErrorCode, gateKey: string, message: string) =>
  ({ ok: false, error: { code, gateKey, message } }) as const;

export type ApplyGatesResult =
  { ok: true; hasGate: boolean; gateCount: number } | { ok: false; error: GateWriteError };

/**
 * 在调用方的事务里对账并落库。先对该帖现有门控行加排他锁（门控行在锁顺序里先于积分账户行，与 unlockGate 一致），
 * 这样"检查有没有解锁记录"到"删除 / 改价"之间不会有人买走。
 */
export async function applyGateDrafts(
  tx: DbExecutor,
  postId: number,
  drafts: readonly GateDraft[],
  perms: GatePermissions,
  /** 仅测试用：在"读完现状、写入之前"暂停，以便确定性地构造并发交错（时序碰运气的并发测试抓不到少加锁的 bug） */
  hooks: { afterRead?: () => Promise<void> } = {},
): Promise<ApplyGatesResult> {
  // 显式列字段：绝不取 hidden_md
  const rows = await tx
    .select({
      id: postGates.id,
      gateKey: postGates.gateKey,
      conditions: postGates.conditions,
      matchMode: postGates.matchMode,
    })
    .from(postGates)
    .where(eq(postGates.postId, postId))
    .for("update");
  const ids = rows.map((r) => r.id);
  const unlocked =
    ids.length === 0
      ? new Set<number>()
      : new Set(
          (
            await tx
              .selectDistinct({ gateId: gateUnlocks.gateId })
              .from(gateUnlocks)
              .where(inArray(gateUnlocks.gateId, ids))
          ).map((r) => r.gateId),
        );
  const withAtt = await gatesWithAttachments(tx, ids);

  const existing: ExistingGate[] = rows.map((r) => ({
    id: r.id,
    gateKey: r.gateKey,
    conditions: Array.isArray(r.conditions) ? (r.conditions as GateCondition[]) : [],
    matchMode: r.matchMode,
    hasUnlocks: unlocked.has(r.id),
    hasAttachments: withAtt.has(r.id),
  }));

  await hooks.afterRead?.();
  const planned = planGateChanges(existing, drafts, perms);
  if (!planned.ok) return planned;
  const { plan } = planned;

  if (plan.deletes.length > 0) {
    await tx.delete(postGates).where(
      and(
        eq(postGates.postId, postId),
        inArray(
          postGates.id,
          plan.deletes.map((d) => d.id),
        ),
      ),
    );
  }
  for (const d of plan.inserts) {
    await tx.insert(postGates).values({
      postId,
      gateKey: d.key,
      conditions: d.conditions,
      matchMode: d.matchMode,
      hiddenMd: d.hiddenMd,
      createdAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    });
  }
  for (const u of plan.updates) {
    // updated_at 只在内容或条件真的变了时推进：编辑帖子的别处不该让所有门控显示"已更新"。
    // 对比放在 SQL 里做——这里不读取旧隐藏正文。
    // 必须用原生 SQL：MySQL 的 UPDATE 按 SET 子句从左到右求值，后面的赋值看到的是前面已更新的列值，所以 updated_at 要排在最前面；
    // 而 drizzle 的 .set() 会按列定义顺序重排（updated_at 被排到最后，比较时 hidden_md 已是新值，永远"没变化"）。write.int.test.ts 守护
    const cond = JSON.stringify(u.draft.conditions);
    await tx.execute(sql`
      UPDATE post_gates SET
        updated_at = IF(
          hidden_md <=> ${u.draft.hiddenMd}
            AND match_mode = ${u.draft.matchMode}
            AND CAST(conditions AS JSON) = CAST(${cond} AS JSON),
          updated_at, NOW()),
        conditions = CAST(${cond} AS JSON),
        match_mode = ${u.draft.matchMode},
        hidden_md = ${u.draft.hiddenMd}
      WHERE id = ${u.id}`);
  }
  const gateCount = existing.length - plan.deletes.length + plan.inserts.length;
  return { ok: true, hasGate: gateCount > 0, gateCount };
}
