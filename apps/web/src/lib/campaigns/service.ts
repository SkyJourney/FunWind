import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { campaigns, getWebDb } from "@funwind/db";
import { findCampaignEffect } from "./effects";

/**
 * 运营排期读取服务（M11.2）。
 *
 * 判定口径与公告横幅完全一致（lib/chrome/site-chrome.ts 的 bannerAnnouncement）：
 *   `starts_at <= NOW() < ends_at`，`ends_at IS NULL` = 长期，请求侧惰性判定、无 cron。
 * 时间比较放在 SQL 里用 NOW()——连接层已 `SET time_zone='+08:00'`，与库内北京墙面值同口径。
 */

export interface CampaignRow {
  id: number;
  name: string;
  effect: string;
  config: unknown;
  startsAt: string;
  endsAt: string | null;
  enabled: boolean;
  priority: number;
}

/** 当前时间窗内、且 effect 已注册的行（SQL 只做时间过滤与排序，选优交给纯函数便于单测） */
export async function loadActiveCampaignRows(): Promise<CampaignRow[]> {
  return await getWebDb()
    .select({
      id: campaigns.id,
      name: campaigns.name,
      effect: campaigns.effect,
      config: campaigns.config,
      startsAt: campaigns.startsAt,
      endsAt: campaigns.endsAt,
      enabled: campaigns.enabled,
      priority: campaigns.priority,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.enabled, true),
        sql`${campaigns.startsAt} <= NOW()`,
        sql`(${campaigns.endsAt} IS NULL OR ${campaigns.endsAt} > NOW())`,
      ),
    )
    .orderBy(campaigns.effect, desc(campaigns.priority), desc(campaigns.id));
}

/**
 * 同 effect 选优（纯函数）：priority 大者胜，相等取 id 大者（后创建）。
 * 未知 effect 键与配置不合法的行一律跳过——一条坏方案不该影响其他 effect 生效。
 */
export function pickWinners(rows: readonly CampaignRow[]): Map<string, CampaignRow> {
  const winners = new Map<string, CampaignRow>();
  for (const row of rows) {
    const registered = findCampaignEffect(row.effect);
    if (!registered) continue;
    if (!registered.schema.safeParse(row.config).success) continue;
    const current = winners.get(row.effect);
    if (!current) {
      winners.set(row.effect, row);
      continue;
    }
    // 相等优先级时取 id 更大者；SQL 已按 (priority DESC, id DESC) 排序，这里显式比较不依赖顺序假设
    if (
      row.priority > current.priority ||
      (row.priority === current.priority && row.id > current.id)
    ) {
      winners.set(row.effect, row);
    }
  }
  return winners;
}

/**
 * 当前生效的方案配置：effect 键 → 已通过校验的配置。
 * 读取失败时返回空表（排期是可选的运营增强，读不到就按"无排期"走常态读取链），
 * 与其他 chrome 字段的故障策略一致：不因可选能力故障拖垮整站。
 */
export async function getActiveCampaignConfigs(): Promise<Map<string, unknown>> {
  let rows: CampaignRow[];
  try {
    rows = await loadActiveCampaignRows();
  } catch (error) {
    console.error("[campaigns] 读取生效方案失败，按无排期处理:", error);
    return new Map();
  }
  const result = new Map<string, unknown>();
  for (const [effect, row] of pickWinners(rows)) {
    result.set(effect, row.config);
  }
  return result;
}
