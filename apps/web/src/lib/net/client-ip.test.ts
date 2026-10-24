import { describe, expect, it } from "vitest";
import { clientIpFrom, trustedProxyHops } from "./client-ip";

const h = (xff?: string) => ({
  get: (n: string) => (n === "x-forwarded-for" ? (xff ?? null) : null),
});

describe("clientIpFrom", () => {
  it("hops=0：不信任任何转发头（伪造的 XFF 也无效），返回 null 而非共享常量", () => {
    expect(clientIpFrom(h("1.2.3.4"), 0)).toBeNull();
  });

  it("hops=1：取最右一项（可信代理看到的对端），客户端伪造的左侧项被忽略", () => {
    expect(clientIpFrom(h("6.6.6.6, 203.0.113.9"), 1)).toBe("203.0.113.9");
  });

  it("hops=2：取从右数第 2 项", () => {
    expect(clientIpFrom(h("6.6.6.6, 203.0.113.9, 10.0.0.1"), 2)).toBe("203.0.113.9");
  });

  it("转发链短于声明层数 / 无头 / 值过长 → null", () => {
    expect(clientIpFrom(h("203.0.113.9"), 2)).toBeNull();
    expect(clientIpFrom(h(undefined), 1)).toBeNull();
    expect(clientIpFrom(h("x".repeat(65)), 1)).toBeNull();
  });
});

describe("trustedProxyHops", () => {
  it("合法正整数原样返回；非法值（负数/非数字/小数）按 0", () => {
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "2" })).toBe(2);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "-1" })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "abc" })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "1.5" })).toBe(0);
  });

  it("开发/测试：未设置按 0", () => {
    expect(trustedProxyHops({})).toBe(0);
    expect(trustedProxyHops({ NODE_ENV: "development" })).toBe(0);
  });

  it("生产：未设置（或空串）直接报错；显式 0（直连无代理）合法", () => {
    expect(() => trustedProxyHops({ NODE_ENV: "production" })).toThrow(/TRUSTED_PROXY_HOPS/);
    expect(() => trustedProxyHops({ NODE_ENV: "production", TRUSTED_PROXY_HOPS: " " })).toThrow();
    expect(trustedProxyHops({ NODE_ENV: "production", TRUSTED_PROXY_HOPS: "0" })).toBe(0);
    expect(trustedProxyHops({ NODE_ENV: "production", TRUSTED_PROXY_HOPS: "1" })).toBe(1);
  });
});
