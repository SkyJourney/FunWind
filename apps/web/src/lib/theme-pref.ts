import { cache } from "react";
import { eq } from "drizzle-orm";
import { getWebDb, userProfiles } from "@funwind/db";
import { DEFAULT_PACK, isPackValue, type PackId } from "@/lib/theme-packs";

/**
 * 用户主题包偏好（M11，user_profiles.theme_pack；docs/THEME-SYSTEM.md §2）：
 * null = 跟随站点默认（site.theme）。读取侧对未知 id 视为 null（注册表删包不需迁移数据）。
 * 生效值由 resolveEffectivePack 合成后在 root layout 直出到 html[data-pack]。
 */

export const getUserThemePack = cache(async (userId: number): Promise<PackId | null> => {
  const [row] = await getWebDb()
    .select({ themePack: userProfiles.themePack })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const v = row?.themePack;
  return typeof v === "string" && isPackValue(v) ? v : null;
});

/** 写偏好（本人外观设置 / 顶栏即时切换）：profile 行缺失时补建（与资料更新同款 upsert） */
export async function setUserThemePack(userId: number, pack: PackId | null): Promise<void> {
  await getWebDb()
    .insert(userProfiles)
    .values({ userId, themePack: pack })
    .onDuplicateKeyUpdate({ set: { themePack: pack } });
}

/** 生效主题包：用户偏好 → 站点默认 → default（纯函数，供单测） */
export function resolveEffectivePack(
  userPref: PackId | null | undefined,
  siteDefault: PackId | null | undefined,
): PackId {
  return userPref ?? siteDefault ?? DEFAULT_PACK;
}
