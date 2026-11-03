import "server-only";

import { cache } from "react";
import { eq } from "drizzle-orm";
import { getWebDb, userProfiles } from "@funwind/db";
import { DEFAULT_PACK } from "@/lib/theme-packs";
import { isKnownPackId } from "@/lib/theme/catalog";

/**
 * 用户主题包偏好（M11，user_profiles.theme_pack；docs/THEME-SYSTEM.md §2）：
 * null = 跟随站点默认（site.theme）。读取侧经目录校验——未知 id 或已停用包都视为 null
 * （删包/停用不需迁移数据；同 id 重导前旧偏好不复活）。
 * 生效值由 resolveEffectivePack 合成后在 root layout 直出到 html[data-pack]。
 */

export const getUserThemePack = cache(async (userId: number): Promise<string | null> => {
  const [row] = await getWebDb()
    .select({ themePack: userProfiles.themePack })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const v = row?.themePack;
  if (typeof v !== "string") return null;
  return (await isKnownPackId(v)) ? v : null;
});

/** 写主题包偏好：目录中未知或停用的包返回 false 且不写入；有效值补建缺失的 profile，数据库错误原样抛出。 */
export async function setUserThemePack(userId: number, pack: string | null): Promise<boolean> {
  if (pack !== null && !(await isKnownPackId(pack))) return false;
  await getWebDb()
    .insert(userProfiles)
    .values({ userId, themePack: pack })
    .onDuplicateKeyUpdate({ set: { themePack: pack } });
  return true;
}

/** 生效主题包：用户偏好 → 站点默认 → default（纯函数；目录校验版见 catalog.resolveEffectivePackValidated） */
export function resolveEffectivePack(
  userPref: string | null | undefined,
  siteDefault: string | null | undefined,
): string {
  return userPref ?? siteDefault ?? DEFAULT_PACK;
}
