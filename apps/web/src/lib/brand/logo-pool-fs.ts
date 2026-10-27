// fs 侧（Node 运行时专用）：仅 Server Action 与公开路由引用，
// 不得被 Server Component 图引入（Turbopack 对组件图里的动态 path 调用报错）。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStorageDir } from "@/lib/storage";
import { getLogoPoolRaw, registerLogo, type LogoPool } from "./logo-pool";

const MAX_BYTES = 512 * 1024;

/** 上传一枚 PNG 入池并设为当前（≤512KB，服务端验魔数）。 */
export async function addLogo(
  name: string,
  bytes: Uint8Array,
): Promise<{ ok: true; pool: LogoPool } | { ok: false; code: "bad_type" | "too_large" }> {
  if (!(bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50))
    return { ok: false, code: "bad_type" };
  if (bytes.length > MAX_BYTES) return { ok: false, code: "too_large" };
  const clean = name.trim().slice(0, 40) || "未命名";
  const file = `logo-${Date.now().toString(36)}.png`;
  const dir = path.join(getStorageDir(), "site");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), bytes);
  const pool = await registerLogo(clean, file);
  return { ok: true, pool };
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
