// fs 侧（Node 运行时专用）：仅 Server Action 与公开路由引用，
// 不得被 Server Component 图引入（Turbopack 对组件图里的动态 path 调用报错）。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CLI_ACTOR, type ConfigActor } from "@/lib/audit";
import { THEME_PACKS, type ThemePack } from "@/lib/theme-packs";
import { createBrandPoolFs, type BrandAddErrorCode } from "./brand-pool-fs";
import { getLogoPoolRaw, logoPool, setActiveLogo } from "./logo-pool";

/** LOGO ≤512KB，像素不限（小图，前台固定 28/36/96px 渲染） */
export const LOGO_MAX_BYTES = 512 * 1024;

export const logoFs = createBrandPoolFs({ pool: logoPool, maxBytes: LOGO_MAX_BYTES });

/** 上传一枚 PNG 入池并设为当前（≤512KB，服务端验魔数）；opts.pack = 主题包自带 LOGO 的来源标签。 */
export const addLogo = logoFs.add;
/** 读取池内 LOGO 字节（/brand/logo）；不传 file 时取当前项，file 必须在池内；无可输出返回 null。 */
export const readLogoBytes = logoFs.readBytes;

/** 只读取代码内登记的内置 LOGO 文件，路径保持构建期可追踪。 */
async function readBundledPackLogo(file: string): Promise<Uint8Array> {
  if (file === "qy2010.png") {
    return readFile(path.join(process.cwd(), "public", "logo", "qy2010.png"));
  }
  throw new Error("未知的内置 LOGO 素材");
}

export type ApplyPackLogoResult =
  | { applied: false; reason: "no-logo" | "unknown-pack" | "missing-asset" | BrandAddErrorCode }
  | { applied: true; imported: boolean; file: string };

/**
 * 主题↔LOGO 联动（M11，docs/THEME-SYSTEM.md §5）：站长把 packId 设为全站默认主题时调用。
 * 包无自带 LOGO → 不触碰池；池内已有该包标签的项 → 只设为当前（幂等，不重复导入）；
 * 不在池（从未导入或已被站长移除）→ 从 public/logo/ 读素材入池（带 pack 标签）并设为当前。
 * 素材缺失/非法只返回原因不抛错——主题切换本身已成功，LOGO 联动是附带动作。
 * packs / readAsset 可注入，供集成测试用临时注册表与素材读取器。
 */
export async function applyPackLogo(
  packId: string,
  actor: ConfigActor = CLI_ACTOR,
  deps: {
    packs?: readonly ThemePack[];
    readAsset?: (file: string) => Promise<Uint8Array>;
  } = {},
): Promise<ApplyPackLogoResult> {
  const pack = (deps.packs ?? THEME_PACKS).find((p) => p.id === packId);
  if (!pack) return { applied: false, reason: "unknown-pack" };
  if (!pack.logo) return { applied: false, reason: "no-logo" };

  const pool = await getLogoPoolRaw();
  const existing = pool.items.find((i) => i.pack === packId);
  if (existing) {
    await setActiveLogo(existing.file, actor);
    return { applied: true, imported: false, file: existing.file };
  }

  let bytes: Uint8Array;
  try {
    bytes = await (deps.readAsset ?? readBundledPackLogo)(pack.logo);
  } catch {
    return { applied: false, reason: "missing-asset" };
  }
  const added = await addLogo(pack.label, bytes, actor, { pack: packId });
  if (!added.ok) return { applied: false, reason: added.code };
  return { applied: true, imported: true, file: added.pool.active! };
}
