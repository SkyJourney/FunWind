/**
 * 客户端 IP 提取（审计、频控共用）。
 * X-Forwarded-For 可被客户端任意伪造，不能直接信任第一项。正确做法：部署时声明前面有几层可信反向代理
 * （TRUSTED_PROXY_HOPS），取“从右数第 N 项”——那是最外层可信代理亲眼看到的对端地址。
 *
 * 取不到可信 IP 时返回 null（不是共享常量）：调用方必须跳过 IP 级限额，只靠账号级限额。
 * 若把所有未知来源归入同一个桶，攻击者几十次失败尝试就能占满它，让全站用户都无法登录（拒绝服务）。
 * 生产环境因此必须显式声明 TRUSTED_PROXY_HOPS（含“0 = 直连、无代理”），漏配直接报错而不是静默退化。
 */

/** 可信代理层数；开发/测试缺省为 0，生产缺省视为配置缺失 */
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "生产环境必须显式设置 TRUSTED_PROXY_HOPS（反向代理层数；直连无代理填 0），见 .env.example",
      );
    }
    return 0;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** 可信 IP；无法确定（未声明代理 / 转发链短于声明层数 / 值异常）返回 null */
export function clientIpFrom(
  headers: { get(name: string): string | null },
  hops: number = trustedProxyHops(),
): string | null {
  if (hops <= 0) return null;
  const parts = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const picked = parts[parts.length - hops];
  // 转发链比声明的代理层数还短 = 头被篡改或配置不符：宁可当作未知，也不信任可伪造的值
  return picked && picked.length <= 64 ? picked : null;
}
