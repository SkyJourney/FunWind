// fs 侧（Node 运行时专用）：仅 Server Action 与公开路由引用，
// 不得被 Server Component 图引入（Turbopack 对组件图里的动态 path 调用报错）。
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { getStorageDir } from "@/lib/storage";
import { sniffType } from "@/lib/uploads/sniff";
import { getLogoPoolRaw, registerLogo, setActiveLogo, type LogoPool } from "./logo-pool";
import { CLI_ACTOR, type ConfigActor } from "@/lib/audit";
import { THEME_PACKS, type ThemePack } from "@/lib/theme-packs";

const MAX_BYTES = 512 * 1024;

/** 上传一枚 PNG 入池并设为当前（≤512KB，服务端验魔数）；opts.pack = 主题包自带 LOGO 的来源标签。 */
export async function addLogo(
  name: string,
  bytes: Uint8Array,
  actor: ConfigActor = CLI_ACTOR,
  opts: { pack?: string } = {},
): Promise<{ ok: true; pool: LogoPool } | { ok: false; code: "bad_type" | "too_large" }> {
  if (bytes.length > MAX_BYTES) return { ok: false, code: "too_large" };
  if (sniffType(bytes) !== "png") return { ok: false, code: "bad_type" };
  try {
    await sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning" }).raw().toBuffer();
  } catch {
    return { ok: false, code: "bad_type" };
  }
  const clean = name.trim().slice(0, 40) || "未命名";
  const file = `logo-${randomBytes(16).toString("hex")}.png`;
  const dir = path.join(getStorageDir(), "site");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, file);
  await writeFile(filePath, bytes, { flag: "wx" });
  try {
    const pool = await registerLogo(clean, file, actor, opts.pack);
    return { ok: true, pool };
  } catch (error) {
    await unlink(filePath).catch(() => {});
    throw error;
  }
}

/** 读取池内 LOGO 字节（/brand/logo）；不传 file 时取当前项，file 必须在池内；无可输出返回 null。 */
export async function readLogoBytes(file?: string): Promise<Uint8Array | null> {
  const pool = await getLogoPoolRaw();
  const target = file ?? pool.active;
  if (!target) return null;
  if (!/^logo-[a-z0-9]+\.png$/.test(target)) return null;
  if (!pool.items.some((i) => i.file === target)) return null;
  try {
    return await readFile(path.join(getStorageDir(), "site", target));
  } catch {
    return null;
  }
}

/** 主题包自带 LOGO 素材目录（apps/web/public/logo/；next 的 cwd = apps/web，与 lib/storage 同口径） */
const packLogoDir = () => path.join(process.cwd(), "public", "logo");

export type ApplyPackLogoResult =
  | {
      applied: false;
      reason: "no-logo" | "unknown-pack" | "missing-asset" | "bad_type" | "too_large";
    }
  | { applied: true; imported: boolean; file: string };

/**
 * 主题↔LOGO 联动（M11，docs/THEME-SYSTEM.md §5）：站长把 packId 设为全站默认主题时调用。
 * 包无自带 LOGO → 不触碰池；池内已有该包标签的项 → 只设为当前（幂等，不重复导入）；
 * 不在池（从未导入或已被站长移除）→ 从 public/logo/ 读素材入池（带 pack 标签）并设为当前。
 * 素材缺失/非法只返回原因不抛错——主题切换本身已成功，LOGO 联动是附带动作。
 * packs / assetDir 可注入，供集成测试用临时注册表与临时素材目录。
 */
export async function applyPackLogo(
  packId: string,
  actor: ConfigActor = CLI_ACTOR,
  deps: { packs?: readonly ThemePack[]; assetDir?: string } = {},
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
    bytes = await readFile(path.join(deps.assetDir ?? packLogoDir(), path.basename(pack.logo)));
  } catch {
    return { applied: false, reason: "missing-asset" };
  }
  const added = await addLogo(pack.label, bytes, actor, { pack: packId });
  if (!added.ok) return { applied: false, reason: added.code };
  return { applied: true, imported: true, file: added.pool.active! };
}
