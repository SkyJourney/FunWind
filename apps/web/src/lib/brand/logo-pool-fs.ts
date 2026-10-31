// fs 侧（Node 运行时专用）：仅 Server Action 与公开路由引用，
// 不得被 Server Component 图引入（Turbopack 对组件图里的动态 path 调用报错）。
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { getStorageDir } from "@/lib/storage";
import { sniffType } from "@/lib/uploads/sniff";
import { getLogoPoolRaw, registerLogo, type LogoPool } from "./logo-pool";
import { CLI_ACTOR, type ConfigActor } from "@/lib/audit";

const MAX_BYTES = 512 * 1024;

/** 上传一枚 PNG 入池并设为当前（≤512KB，服务端验魔数）。 */
export async function addLogo(
  name: string,
  bytes: Uint8Array,
  actor: ConfigActor = CLI_ACTOR,
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
    const pool = await registerLogo(clean, file, actor);
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
