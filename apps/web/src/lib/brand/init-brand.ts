import "server-only";

import { CLI_ACTOR, type ConfigActor } from "@/lib/audit";
import { applyPackLogo } from "./logo-pool-fs";
import { getLogoPoolRaw } from "./logo-pool";

/** 默认站标来源包：qy2010 情怀包自带 LOGO = 站长定稿「清爽侦探半翼」（public/logo/qy2010.png） */
export const DEFAULT_LOGO_PACK = "qy2010";
export const DEFAULT_LOGO_LABEL = "清爽侦探半翼";

export type InitBrandResult =
  | { action: "skipped-active"; file: string }
  | { action: "initialized"; file: string }
  | { action: "failed"; reason: string };

/**
 * 默认站标初始化（M13 D2，docs/milestones/M13-launch.md）：
 * 池已有当前项（含池内存在但 active 为空的包项激活）→ 幂等跳过/复用，**绝不覆盖站长的自定义选择**；
 * 池为空 → 把定稿图入池（qy2010 包标签，后台可溯源）并设为当前。
 * 两条入口共用：零数据安装（向导/CLI 的 site-settings 步骤自动调用）与
 * 导入路径上线检查单（`pnpm init-brand`，users 非空时安装管线不跑品牌段——F4）。
 * 返回原因不抛错：品牌是附带动作，安装/上线不因素材问题失败。
 */
export async function ensureDefaultLogo(actor: ConfigActor = CLI_ACTOR): Promise<InitBrandResult> {
  const pool = await getLogoPoolRaw();
  if (pool.active && pool.items.some((i) => i.file === pool.active)) {
    return { action: "skipped-active", file: pool.active };
  }

  const applied = await applyPackLogo(DEFAULT_LOGO_PACK, actor, {
    packs: [{ id: DEFAULT_LOGO_PACK, label: DEFAULT_LOGO_LABEL, logo: "qy2010.png" }],
  });
  if (!applied.applied) return { action: "failed", reason: applied.reason };
  return { action: "initialized", file: applied.file };
}
