import { cache } from "react";
import { eq } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";
import type { Subject } from "@/lib/authz/types";
import {
  applicableRoleKeys,
  parseLimitsConfig,
  resolveLimits,
  type LimitsConfig,
  type ResolvedLimits,
} from "./config";

/** 读取写入限制配置（请求级缓存）。库里没有 → 默认；无效 → 默认并告警（不抛错，发帖不应因配置写坏而整体不可用） */
export const getLimitsConfig = cache(async (): Promise<LimitsConfig> => {
  const rows = await getWebDb()
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, "limits"))
    .limit(1);
  const { config, error } = parseLimitsConfig(rows[0]?.value);
  if (error) console.warn(`[limits] site_settings.limits 无效，已回落到默认值：${error}`);
  return config;
});

/** 主体在目标版块内最终生效的限制（版块缺省 = 站点级） */
export async function limitsFor(subject: Subject, forumId?: number): Promise<ResolvedLimits> {
  const [config, snap] = await Promise.all([getLimitsConfig(), getAuthzSnapshot()]);
  return resolveLimits(config, applicableRoleKeys(subject, snap.tree, forumId));
}
