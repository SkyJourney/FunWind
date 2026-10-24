import { and, eq, sql } from "drizzle-orm";
import { gateUnlocks, getWebDb, postGates, siteSettings, users } from "@funwind/db";
import { checkPermission } from "@/lib/authz/service";
import type { Subject } from "@/lib/authz/types";
import { emit } from "@/modules/kernel/bus";
import type { EventName, EventPayloads } from "@/modules/kernel/types";
import { lockAccounts } from "@/lib/points/account";
import { applyPointsInTx, builtinChannel } from "@/lib/points/apply";
import { InsufficientPointsError, PointsOverflowError } from "@/lib/points/errors";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { gateOpenReason, locateGate, type GateLocation } from "./service";
import { KNOWN_CONDITION_TYPES } from "./evaluate";
import { parseConditions } from "./parse";

/**
 * 门控购买（docs/GATES.md §5）：单个数据库事务内完成扣款、作者收益、解锁记录。
 *
 * 并发语义（“双击只扣一次”的关键）：**先拿账户行锁，再检查是否已解锁**。
 * 第二个请求阻塞在读者账户的行锁上，等第一个提交后在锁内读到解锁记录，直接返回“已解锁”而不扣费。
 * 账户按 user_id 升序加锁以避免死锁；仍遇死锁则整体重试。
 * 幂等键：读者 gate_unlock:{gateId}:{userId}，作者 gate_sale:{gateId}:{userId}（解锁记录的主键与台账唯一键是最后兜底）。
 *
 * 价格核对（expectedPrice）：买家点击时看到的价格可能在提交前被作者改掉。调用方传入「买家看到的价格」，
 * 事务内锁住门控行后与当前价比对，不符返回 price_changed、不扣费；这样扣款金额永远是买家确认过的金额。
 * 已解锁者不受影响（不扣费，直接返回已解锁）。省略 expectedPrice 表示不核对，仅限内部调用；
 * 面向用户的入口（Server Action）必须传。
 *
 * 结果用固定的错误码而不是自由文本：页面只据此映射文案，重定向 URL 里不带任何用户可控内容。
 */

export type UnlockCode =
  | "login"
  | "not_found"
  | "own_content"
  | "insufficient"
  | "unavailable"
  /** 门控已因购买以外的条件对该读者开放（如 any 模式下已回帖），无需也不应再扣款 */
  | "already_open"
  /** 门控的当前价格与买家确认的价格（expectedPrice）不符 */
  | "price_changed";

export type UnlockResult =
  | { ok: true; alreadyUnlocked: boolean; pricePaid: number; target: GateLocation }
  | { ok: false; code: UnlockCode; target?: GateLocation };

export interface UnlockDeps {
  /** 覆盖事件派发（单测注入；缺省走内核总线） */
  emitter?: <K extends EventName>(name: K, payload: EventPayloads[K]) => Promise<unknown>;
}

export interface UnlockOptions extends UnlockDeps {
  /** 买家确认过的价格（整数）；与事务内锁到的当前价不符则拒绝。省略 = 不核对（仅限内部调用） */
  expectedPrice?: number;
}

const defaultEmitter: NonNullable<UnlockDeps["emitter"]> = (name, payload) =>
  emit(name, payload, { source: "gate" });

/** 站点手续费率（points.gate_fee_rate）：[0, 1) 之外一律按 0，避免配置错误吞掉作者全部收益 */
export async function getGateFeeRate(): Promise<number> {
  const [row] = await getWebDb()
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, "points.gate_fee_rate"))
    .limit(1);
  const rate = (row?.value as { rate?: unknown } | undefined)?.rate;
  return typeof rate === "number" && rate >= 0 && rate < 1 ? rate : 0;
}

/** 手续费 = floor(价格 × 费率)，作者得到其余（取整有利于作者；费率为 0 时无影响） */
export const feeOf = (price: number, rate: number): number => Math.floor(price * rate);

export async function unlockGate(
  viewer: Subject,
  gateId: number,
  deps: UnlockOptions = {},
): Promise<UnlockResult> {
  const viewerId = viewer.userId;
  if (viewerId === null) return { ok: false, code: "login" };

  // —— 事务外：定位（含可见性）、权限与静态配置。事务内不再借第二条连接（连接池饥饿，见 points/apply.ts）——
  const target = await locateGate(viewer, gateId);
  if (!target) return { ok: false, code: "not_found" };
  if (target.authorId === viewerId) return { ok: false, code: "own_content", target };
  if ((await checkPermission(viewer, "forum.moderate", { forumId: target.forumId })).allowed) {
    return { ok: false, code: "own_content", target };
  }

  // 已经能看（any 模式下已回帖等）就不该再扣款。reason=unlocked 是「买过了」，交给事务内的幂等路径处理
  const openBy = await gateOpenReason(
    viewer,
    { id: target.threadId, forumId: target.forumId },
    { id: target.postId, authorId: target.authorId },
    gateId,
  );
  if (openBy === "replied") return { ok: false, code: "already_open", target };

  const db = getWebDb();
  const [authorRow] = await db
    .select({ state: users.state })
    .from(users)
    .where(eq(users.id, target.authorId))
    .limit(1);
  const authorAlive = authorRow?.state === "active";
  const feeRate = await getGateFeeRate();
  const spendChannel = builtinChannel("spend.gate_unlock");
  const earnChannel = builtinChannel("earn.gate_sale");

  type Outcome =
    | { ok: false; code: UnlockCode }
    | { ok: true; alreadyUnlocked: boolean; pricePaid: number; events: PendingEvent[] };
  type PendingEvent = { name: EventName; payload: EventPayloads[EventName] };

  let outcome: Outcome;
  try {
    outcome = await withDeadlockRetry(() =>
      db.transaction(async (tx): Promise<Outcome> => {
        // 加锁顺序固定为「门控行 → 账户行（user_id 升序）」。门控行必须一开始就拿排他锁：
        // 若先拿共享锁、最后更新 unlock_count 时再升级，同一门控的多个购买者会互相等待升级而死锁。
        // 同一门控的购买因此串行化（事务极短）；持锁期间价格也不会被改，后续按此价格结算。
        const [gate] = await tx
          .select({ conditions: postGates.conditions, matchMode: postGates.matchMode })
          .from(postGates)
          .where(eq(postGates.id, gateId))
          .for("update");
        if (!gate) return { ok: false, code: "not_found" };
        const conditions = parseConditions(gate.conditions);
        const points = conditions.find((c) => c.type === "points");
        const price = points?.price;
        if (!points || typeof price !== "number" || !Number.isInteger(price) || price < 0) {
          return { ok: false, code: "unavailable" };
        }
        // 「全部满足」的门控里有未知类型的条件：它永远无法满足，付了款也看不到内容 = 白扣钱。事先封闭，不扣费。
        // （「任一满足」模式下积分条件足以开门，未知条件被忽略，照常可购买。）
        if (
          gate.matchMode === "all" &&
          conditions.some((c) => !KNOWN_CONDITION_TYPES.has(c.type))
        ) {
          return { ok: false, code: "unavailable" };
        }

        // 先锁账户，再查是否已解锁
        if (price > 0)
          await lockAccounts(tx, authorAlive ? [viewerId, target.authorId] : [viewerId]);
        const [existing] = await tx
          .select({ pricePaid: gateUnlocks.pricePaid })
          .from(gateUnlocks)
          .where(and(eq(gateUnlocks.gateId, gateId), eq(gateUnlocks.userId, viewerId)))
          .for("update");
        if (existing) {
          return { ok: true, alreadyUnlocked: true, pricePaid: existing.pricePaid, events: [] };
        }

        // 价格核对放在「已解锁」判断之后：已买过的人不会因为后来改价而看到错误；
        // 此处门控行已被排他锁住，比对用的价格与随后扣款的价格是同一个值，中间不可能再被改动
        if (deps.expectedPrice !== undefined && deps.expectedPrice !== price) {
          return { ok: false, code: "price_changed" };
        }

        const events: PendingEvent[] = [];
        let ledgerId: number | null = null;
        let income = 0;
        if (price > 0) {
          const spend = await applyPointsInTx(
            tx,
            {
              userId: viewerId,
              channel: "spend.gate_unlock",
              delta: -price,
              idempotencyKey: `gate_unlock:${gateId}:${viewerId}`,
              ref: { type: "gate", id: gateId },
              note: "解锁付费内容",
            },
            spendChannel,
          );
          ledgerId = spend.ledgerId;
          if (spend.event) events.push({ name: "points.changed", payload: spend.event });

          // 作者账号已注销（历史孤儿作者）：收益直接销毁，不写台账
          income = authorAlive ? price - feeOf(price, feeRate) : 0;
          if (income > 0) {
            const sale = await applyPointsInTx(
              tx,
              {
                userId: target.authorId,
                channel: "earn.gate_sale",
                delta: income,
                idempotencyKey: `gate_sale:${gateId}:${viewerId}`,
                ref: { type: "gate", id: gateId },
                note: "付费内容收益",
              },
              earnChannel,
            );
            if (sale.event) events.push({ name: "points.changed", payload: sale.event });
          }
        }

        await tx.insert(gateUnlocks).values({
          gateId,
          userId: viewerId,
          pricePaid: price,
          authorIncome: income,
          ledgerId,
          unlockedAt: sql`NOW()`,
        });
        await tx
          .update(postGates)
          .set({ unlockCount: sql`${postGates.unlockCount} + 1` })
          .where(eq(postGates.id, gateId));
        events.push({
          name: "gate.unlocked",
          payload: { gateId, userId: viewerId, authorId: target.authorId, price },
        });
        return { ok: true, alreadyUnlocked: false, pricePaid: price, events };
      }, POINTS_TX_OPTIONS),
    );
  } catch (e) {
    if (e instanceof InsufficientPointsError) return { ok: false, code: "insufficient", target };
    // 作者账户已到余额上限、收益入不了账：整笔回滚（读者没有被扣费），对读者表现为暂不可购买而不是 500
    if (e instanceof PointsOverflowError) return { ok: false, code: "unavailable", target };
    throw e;
  }

  if (!outcome.ok) return { ok: false, code: outcome.code, target };

  // 提交后派发事件；派发失败只记日志，不影响已完成的购买
  const emitter = deps.emitter ?? defaultEmitter;
  for (const ev of outcome.events) {
    try {
      await emitter(ev.name, ev.payload as never);
    } catch (e) {
      console.error(`[gate] ${ev.name} 派发失败（购买已提交）:`, e);
    }
  }
  return {
    ok: true,
    alreadyUnlocked: outcome.alreadyUnlocked,
    pricePaid: outcome.pricePaid,
    target,
  };
}
