import "server-only";

import { eq, sql } from "drizzle-orm";
import { campaigns, getWebDb } from "@funwind/db";
import { findCampaignEffect, targetOfConfig, validateCampaignConfig } from "./effects";
import { campaignStatus, overriddenBy, type CampaignStatus } from "./status";

/**
 * 后台列表读取（M11.2）。状态用数据库 NOW() 判定，与前台读取链同一个时钟；
 * 方案数量很少（运营排期，不是内容流），不做分页，只设一个上限防止异常数据拖垮页面。
 */

const LIST_LIMIT = 500;

export interface CampaignListItem {
  id: number;
  name: string;
  effect: string;
  effectLabel: string;
  /** 目标值（包 id / 池文件名）；配置损坏时为 null */
  target: string | null;
  startsAt: string;
  endsAt: string | null;
  enabled: boolean;
  priority: number;
  revision: number;
  status: CampaignStatus;
  /** 配置或效果类型无效（读取链会忽略这一行） */
  invalid: boolean;
  /** 在重叠时段被它压制的方案 id；null = 未被压制 */
  overriddenBy: number | null;
}

export async function listCampaigns(): Promise<{ items: CampaignListItem[]; now: string }> {
  const db = getWebDb();
  const [clock, rows] = await Promise.all([
    db.execute(sql`SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS now`),
    db.select().from(campaigns).orderBy(campaigns.effect, campaigns.priority).limit(LIST_LIMIT),
  ]);
  const [clockRows] = clock as unknown as [{ now: string }[]];
  const now = clockRows?.[0]?.now ?? "";
  const overrides = overriddenBy(rows, now);
  const items = rows.map((row): CampaignListItem => {
    const effect = findCampaignEffect(row.effect);
    const invalid = !effect || !validateCampaignConfig(row.effect, row.config).ok;
    return {
      id: row.id,
      name: row.name,
      effect: row.effect,
      effectLabel: effect?.label ?? row.effect,
      target: targetOfConfig(row.effect, row.config),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      enabled: row.enabled,
      priority: row.priority,
      revision: row.revision,
      status: campaignStatus(row, now),
      invalid,
      overriddenBy: overrides.get(row.id) ?? null,
    };
  });
  return { items, now };
}

/** 管理单条详情（M20.3 Step 3 供 GET /api/manage/campaigns/{id} 使用）：与列表同口径映射；不存在返回 null。 */
export async function getCampaign(id: number): Promise<CampaignListItem | null> {
  const [row] = await getWebDb().select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  if (!row) return null;
  const rows = [row];
  const [clockRows] = (await getWebDb().execute(
    sql`SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS now`,
  )) as unknown as [{ now: string }[]];
  const now = clockRows?.[0]?.now ?? "";
  const effect = findCampaignEffect(row.effect);
  return {
    id: row.id,
    name: row.name,
    effect: row.effect,
    effectLabel: effect?.label ?? row.effect,
    target: targetOfConfig(row.effect, row.config),
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    enabled: row.enabled,
    priority: row.priority,
    revision: row.revision,
    status: campaignStatus(row, now),
    invalid: !effect || !validateCampaignConfig(row.effect, row.config).ok,
    overriddenBy: overriddenBy(rows, now).get(row.id) ?? null,
  };
}
