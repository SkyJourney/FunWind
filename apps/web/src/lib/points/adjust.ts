import { randomUUID } from "node:crypto";
import { getWebDb } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { emit } from "@/modules/kernel/bus";
import { applyPointsInTx, resolveChannelOrThrow, type ApplyPointsResult } from "./apply";
import { InvalidDeltaError } from "./errors";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "./retry";

/**
 * 管理员手工调整（M7，docs/POINTS.md §4 `adjust.admin`）：强制备注、出审计。
 * 台账写入与 audit_log 在**同一事务**（与 authz/admin.ts 同纪律：不存在「改了余额却没留痕」的窗口）；
 * 事务以 POINTS_TX_OPTIONS（READ COMMITTED）开启（M7-2 口径），提交后派发 `points.changed`。
 *
 * 幂等键：每次调整一个随机 UUID——手工调整没有「同一业务动作重放」的语义，重放反而危险
 * （管理员点两次就是两笔）。防重由 UI 提交与频控负责。
 */

export interface AdjustRequest {
  /** 被调整的用户 */
  userId: number;
  /** 非零整数：正为增加、负为扣减 */
  delta: number;
  /** 强制备注（入台账 note 与审计 after_json） */
  note: string;
}

export async function adjustPointsByAdmin(
  admin: ConfigActor & { userId: number },
  req: AdjustRequest,
): Promise<ApplyPointsResult> {
  if (!Number.isInteger(req.delta) || req.delta === 0) {
    throw new InvalidDeltaError(`调整额度必须是非零整数: ${req.delta}`);
  }
  const note = req.note.trim();
  if (!note) throw new InvalidDeltaError("必须填写调整备注");

  const channel = await resolveChannelOrThrow("adjust.admin");

  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      const res = await applyPointsInTx(
        tx,
        {
          userId: req.userId,
          channel: "adjust.admin",
          delta: req.delta,
          idempotencyKey: `adjust:${randomUUID()}`,
          ref: { type: "admin", id: admin.userId },
          note,
        },
        channel,
      );
      await writeAudit(tx, {
        actorId: admin.userId,
        action: "points.adjust",
        targetType: "user",
        targetId: req.userId,
        before: { balance: res.balanceAfter - req.delta },
        after: { balance: res.balanceAfter, delta: req.delta, note, via: admin.via },
        ip: admin.ip,
      });
      return res;
    }, POINTS_TX_OPTIONS),
  );

  if (result.event) {
    try {
      await emit("points.changed", result.event, { source: "points" });
    } catch (e) {
      console.error("[points] points.changed 派发失败（调整已提交）:", e);
    }
  }
  return result;
}
