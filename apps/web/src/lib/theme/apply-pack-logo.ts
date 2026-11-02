import { getLogoPoolRaw, setActiveLogo } from "@/lib/brand/logo-pool";
import { applyPackLogo, type ApplyPackLogoResult } from "@/lib/brand/logo-pool-fs";
import type { ConfigActor } from "@/lib/audit";
import { getThemePack, parseThemePackAssets } from "./packs";

/** 数据包使用素材池 LOGO；没有数据库 LOGO 引用时回退静态内置包联动。 */
export async function applyThemePackLogo(
  packId: string,
  actor: ConfigActor,
): Promise<ApplyPackLogoResult> {
  const pack = await getThemePack(packId);
  const logo = parseThemePackAssets(pack?.assets).find((asset) => asset.kind === "logo");
  if (!logo) return applyPackLogo(packId, actor);

  const pool = await getLogoPoolRaw();
  if (!pool.items.some((item) => item.file === logo.poolFile)) {
    return { applied: false, reason: "missing-asset" };
  }
  await setActiveLogo(logo.poolFile, actor);
  return { applied: true, imported: false, file: logo.poolFile };
}
