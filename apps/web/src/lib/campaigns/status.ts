/**
 * 运营排期方案的状态与重叠判定（M11.2，纯函数，无 IO，前后台通用）。
 *
 * 时间一律是北京墙面时间字符串 "YYYY-MM-DD HH:MM:SS"，同格式字符串的字典序即时间先后，
 * 因此这里直接比较字符串；`now` 由调用方传入（后台列表取数据库 NOW()，与前台读取同一时钟）。
 * 区间语义与读取链一致：左闭右开 `[starts_at, ends_at)`，ends_at 为 null = 长期。
 */

export type CampaignStatus = "disabled" | "upcoming" | "active" | "ended";

export interface CampaignWindow {
  id: number;
  effect: string;
  enabled: boolean;
  startsAt: string;
  endsAt: string | null;
  priority: number;
}

/** 方案当前状态：停用优先于时间判断（停用的方案无论窗口在哪都不参与生效） */
export function campaignStatus(
  row: Pick<CampaignWindow, "enabled" | "startsAt" | "endsAt">,
  now: string,
): CampaignStatus {
  if (!row.enabled) return "disabled";
  if (row.endsAt !== null && row.endsAt <= now) return "ended";
  if (row.startsAt > now) return "upcoming";
  return "active";
}

/** 两个半开窗口是否有公共时段（首尾相接不算相交） */
function intersects(a: CampaignWindow, b: CampaignWindow): boolean {
  const aEndsAfterBStarts = a.endsAt === null || a.endsAt > b.startsAt;
  const bEndsAfterAStarts = b.endsAt === null || b.endsAt > a.startsAt;
  return aEndsAfterBStarts && bEndsAfterAStarts;
}

/** a 是否压过 b：priority 大者胜，相等取 id 大者（与读取链的选优口径一致） */
function outranks(a: CampaignWindow, b: CampaignWindow): boolean {
  return a.priority > b.priority || (a.priority === b.priority && a.id > b.id);
}

/**
 * 找出「在重叠时段被同 effect 的更高优先级方案压制」的方案：返回 被压制方案 id → 压制它的最高优先级方案 id。
 * 只考虑未结束且未停用的方案——已结束或已停用的方案不会再参与生效，提示它们只是噪声。
 * 这是提示而不是约束：保存时不阻止重叠，由 priority 决定谁生效。
 */
export function overriddenBy(rows: readonly CampaignWindow[], now: string): Map<number, number> {
  const live = rows.filter((row) => {
    const status = campaignStatus(row, now);
    return status === "active" || status === "upcoming";
  });
  const result = new Map<number, number>();
  for (const row of live) {
    let best: CampaignWindow | null = null;
    for (const other of live) {
      if (other.id === row.id || other.effect !== row.effect) continue;
      if (!intersects(row, other) || !outranks(other, row)) continue;
      if (!best || outranks(other, best)) best = other;
    }
    if (best) result.set(row.id, best.id);
  }
  return result;
}
