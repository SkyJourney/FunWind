import { createHmac, randomBytes } from "node:crypto";

/**
 * 全站主题预览签名（M11.1 Step 7）：站长在编辑器点「全站预览」后 10 分钟内，
 * 本人浏览器经签名 cookie 以目标包渲染整站（不落库、不影响其他访客）。
 * cookie 值 = `<packId>.<expEpochSec>.<HMAC-SHA256(packId.exp)>`；
 * 密钥优先取 THEME_PREVIEW_SECRET env；缺省用进程启动时随机密钥（单实例部署足够，
 * 多实例时各自签发/校验，cookie 只在签发实例有效——预览属临时态，可接受）。
 */

export const THEME_PREVIEW_COOKIE = "fw_theme_preview";
/** 预览有效期（秒） */
export const THEME_PREVIEW_TTL_SEC = 600;

const g = globalThis as unknown as { __fwThemePreviewSecret?: string };

/** 解析签名密钥：env 优先，否则进程内随机（懒生成一次） */
export function themePreviewSecret(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.THEME_PREVIEW_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (!g.__fwThemePreviewSecret) g.__fwThemePreviewSecret = randomBytes(32).toString("hex");
  return g.__fwThemePreviewSecret;
}

function signature(packId: string, exp: number, secret: string): string {
  return createHmac("sha256", secret).update(`${packId}.${exp}`).digest("base64url");
}

/** 签发 cookie 值；packId 须已过 THEME_PACK_ID_RE 校验 */
export function signThemePreview(
  packId: string,
  nowSec: number,
  secret = themePreviewSecret(),
  ttlSec: number = THEME_PREVIEW_TTL_SEC,
): string {
  const exp = Math.floor(nowSec) + ttlSec;
  return `${packId}.${exp}.${signature(packId, exp, secret)}`;
}

/** 校验并解出预览包 id；格式/签名/有效期任一不过 → null（调用方再经目录校验启用状态） */
export function verifyThemePreview(
  cookieValue: string | undefined,
  nowSec: number,
  secret = themePreviewSecret(),
): string | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;
  const [packId, expRaw, mac] = parts as [string, string, string];
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(packId)) return null;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(nowSec)) return null;
  const expected = signature(packId, exp, secret);
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqualStr(mac, expected)) return null;
  return packId;
}

/** 常量时间字符串比较（长度相同的前提下逐字节异或） */
function timingSafeEqualStr(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
