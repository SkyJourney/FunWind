import type { GateCondition } from "@funwind/content";
import type { GateDecision, GateFacts, GateMeta, GatePrompt } from "./types";

/**
 * 门控判定（纯函数，零 IO）。规则见 docs/GATES.md §3–§4：
 *   作者 / 版主 / admin 永远可见 → 未登录一律锁定并引导登录 → 逐条件判定，match_mode 为 all 或 any。
 * 失败即封闭：未知条件类型（模块被停用、数据脏）视为不满足，且不向普通观众透露条件细节。
 */

interface ConditionOutcome {
  satisfied: boolean;
  prompt: GatePrompt;
  /** 满足时的开放原因（用于界面标签） */
  reason?: "unlocked" | "replied";
  pricePaid?: number;
  unlockedAt?: string;
}

/** 积分价格：非负整数；缺失/非法按「不可用」封闭处理（迁移已把 ≥9999 的异常价格重置为 0，此处不再兜底放行） */
function priceOf(c: GateCondition): number | null {
  const p = c.price;
  return typeof p === "number" && Number.isInteger(p) && p >= 0 ? p : null;
}

/**
 * 门控核心认识的条件类型。门控条件固定为这两种（M6.1 删除了模块注册边界 gateConditions）；
 * 库里出现其他类型只会是脏数据（或早先某个已删除模块写入的遗留），求值一律按「暂不可用」封闭。
 */
export const KNOWN_CONDITION_TYPES: ReadonlySet<string> = new Set(["points", "reply"]);

function checkCondition(gate: GateMeta, c: GateCondition, facts: GateFacts): ConditionOutcome {
  switch (c.type) {
    case "points": {
      const price = priceOf(c);
      if (price === null) return { satisfied: false, prompt: { kind: "unavailable" } };
      const rec = facts.unlocked.get(gate.id);
      if (rec) {
        return {
          satisfied: true,
          prompt: { kind: "points", price, balance: facts.balance },
          reason: "unlocked",
          pricePaid: rec.pricePaid,
          unlockedAt: rec.unlockedAt,
        };
      }
      return { satisfied: false, prompt: { kind: "points", price, balance: facts.balance } };
    }
    case "reply":
      return facts.hasReplied
        ? { satisfied: true, prompt: { kind: "reply" }, reason: "replied" }
        : { satisfied: false, prompt: { kind: "reply" } };
    default:
      return { satisfied: false, prompt: { kind: "unavailable" } };
  }
}

export function evaluateGate(gate: GateMeta, facts: GateFacts): GateDecision {
  if (facts.isAuthor) return { open: true, reason: "author" };
  if (facts.isModerator) return { open: true, reason: "moderator" };
  if (facts.viewerId === null) return { open: false, prompts: [{ kind: "login" }] };

  // 没有任何条件的门控是脏数据：封闭
  if (gate.conditions.length === 0) return { open: false, prompts: [{ kind: "unavailable" }] };

  const outcomes = gate.conditions.map((c) => checkCondition(gate, c, facts));
  const ok =
    gate.matchMode === "any"
      ? outcomes.some((o) => o.satisfied)
      : outcomes.every((o) => o.satisfied);
  if (ok) {
    // 展示用：优先取已解锁记录（购买时间/金额），否则取第一个满足的条件
    const hit =
      outcomes.find((o) => o.satisfied && o.reason === "unlocked") ??
      outcomes.find((o) => o.satisfied)!;
    return {
      open: true,
      reason: hit.reason ?? "unlocked",
      pricePaid: hit.pricePaid,
      unlockedAt: hit.unlockedAt,
    };
  }
  // 提示只列出尚未满足的条件，去重
  const prompts: GatePrompt[] = [];
  for (const o of outcomes) {
    if (o.satisfied) continue;
    if (!prompts.some((p) => p.kind === o.prompt.kind)) prompts.push(o.prompt);
  }
  return { open: false, prompts };
}
