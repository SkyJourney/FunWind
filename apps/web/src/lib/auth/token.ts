import { createHash, randomBytes } from "node:crypto";

/**
 * 令牌工具：不透明令牌 = 32 字节随机 → URL-safe 字符串；库内只存 SHA-256。
 * （会话 cookie 与邮件令牌共用此机制：库泄漏 ≠ 会话/账号劫持）
 */

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
