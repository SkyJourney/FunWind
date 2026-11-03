import "server-only";

import { getHeroPoolRaw } from "@/lib/brand/hero-pool";
import { getLogoPoolRaw } from "@/lib/brand/logo-pool";
import { isKnownPackId } from "@/lib/theme/catalog";

/**
 * 方案引用目标是否仍然有效（写入前校验与后台列表的「引用失效」提示共用）：
 *  · theme.pack：包必须在目录里（存在且已启用）；
 *  · site.logo / site.hero：文件必须在对应素材池清单内。
 * 新增 effect 时在这里补一个分支；未注册的 effect 一律视为无效。
 * 读取链（site-chrome）有同口径的逐项回退，所以这里的失败只用于拒绝保存与提示，不影响站点渲染。
 */
export async function campaignRefExists(effect: string, target: string): Promise<boolean> {
  if (effect === "theme.pack") return isKnownPackId(target);
  if (effect === "site.logo") return (await getLogoPoolRaw()).items.some((i) => i.file === target);
  if (effect === "site.hero") return (await getHeroPoolRaw()).items.some((i) => i.file === target);
  return false;
}
