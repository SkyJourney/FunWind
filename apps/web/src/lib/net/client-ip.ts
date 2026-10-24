/**
 * 客户端 IP 提取（审计、频控共用）。
 * X-Forwarded-For 可被客户端任意伪造，不能直接信任第一项。正确做法：部署时声明前面有几层可信反向代理
 * （TRUSTED_PROXY_HOPS），取“从右数第 N 项”——那是最外层可信代理亲眼看到的对端地址。
 * 默认 0 = 不信任任何转发头，所有请求归入同一个 "unknown" 桶（安全但粗放；生产必须配置）。
 */

export const UNKNOWN_IP = "unknown";

export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.TRUSTED_PROXY_HOPS ?? "0");
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function clientIpFrom(
  headers: { get(name: string): string | null },
  hops: number = trustedProxyHops(),
): string {
  if (hops <= 0) return UNKNOWN_IP;
  const parts = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const picked = parts[parts.length - hops];
  // 转发链比声明的代理层数还短 = 头被篡改或配置不符：宁可归入未知桶，也不信任可伪造的值
  return picked && picked.length <= 64 ? picked : UNKNOWN_IP;
}
