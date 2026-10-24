import { describe, expect, it } from "vitest";
import { UNKNOWN_IP, clientIpFrom, trustedProxyHops } from "./client-ip";

const h = (xff?: string) => ({
  get: (n: string) => (n === "x-forwarded-for" ? (xff ?? null) : null),
});

describe("clientIpFrom", () => {
  it("hops=0：不信任任何转发头（伪造的 XFF 也无效）", () => {
    expect(clientIpFrom(h("1.2.3.4"), 0)).toBe(UNKNOWN_IP);
  });

  it("hops=1：取最右一项（可信代理看到的对端），客户端伪造的左侧项被忽略", () => {
    expect(clientIpFrom(h("6.6.6.6, 203.0.113.9"), 1)).toBe("203.0.113.9");
  });

  it("hops=2：取从右数第 2 项", () => {
    expect(clientIpFrom(h("6.6.6.6, 203.0.113.9, 10.0.0.1"), 2)).toBe("203.0.113.9");
  });

  it("转发链短于声明层数 / 无头 / 值过长 → 未知桶", () => {
    expect(clientIpFrom(h("203.0.113.9"), 2)).toBe(UNKNOWN_IP);
    expect(clientIpFrom(h(undefined), 1)).toBe(UNKNOWN_IP);
    expect(clientIpFrom(h("x".repeat(65)), 1)).toBe(UNKNOWN_IP);
  });

  it("trustedProxyHops：非法值按 0", () => {
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "2" })).toBe(2);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "-1" })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "abc" })).toBe(0);
    expect(trustedProxyHops({})).toBe(0);
  });
});
