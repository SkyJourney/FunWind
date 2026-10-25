import { cache } from "react";
import { eq } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";
import {
  parsePointReward,
  parsePunchReward,
  type PointReward,
  type PunchReward,
} from "./reward-config";

/**
 * 奖励配置读取（请求级缓存）。库里没有 → 默认；无效 → 默认并告警（不抛错——
 * 一份写坏的配置不应让发帖/签到/积分页整体不可用，与 limits 同一口径）。
 */

async function readSetting(key: string): Promise<unknown> {
  const rows = await getWebDb()
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, key))
    .limit(1);
  return rows[0]?.value;
}

export const getPointRewardConfig = cache(async (): Promise<PointReward> => {
  const { config, error } = parsePointReward(await readSetting("points.reward"));
  if (error) console.warn(`[points] site_settings.points.reward 无效，已回落到默认值：${error}`);
  return config;
});

export const getPunchRewardConfig = cache(async (): Promise<PunchReward> => {
  const { config, error } = parsePunchReward(await readSetting("punch.reward"));
  if (error) console.warn(`[points] site_settings.punch.reward 无效，已回落到默认值：${error}`);
  return config;
});
