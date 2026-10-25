// @vitest-environment node
import { describe, expect, it } from "vitest";
import { visitorKey } from "./record";

/** 访客身份规则：登录用户按账号；游客按可信 IP；拿不到 IP 时统一归入 unknown，绝不由 User-Agent 决定 */
describe("visitorKey", () => {
  it("登录用户按账号，与 IP 无关", () => {
    expect(visitorKey(7, "198.51.100.1")).toBe("u:7");
    expect(visitorKey(7, null)).toBe("u:7");
  });

  it("游客按 IP 哈希：同一 IP 稳定，不同 IP 不同，且不含原始 IP", () => {
    const a = visitorKey(null, "198.51.100.1");
    expect(a).toBe(visitorKey(null, "198.51.100.1"));
    expect(a).not.toBe(visitorKey(null, "198.51.100.2"));
    expect(a).not.toContain("198.51.100.1");
    expect(a).toMatch(/^g:[0-9a-f]{32}$/);
  });

  it("拿不到可信 IP 的游客统一为固定键（不依赖任何请求头）", () => {
    expect(visitorKey(null, null)).toBe("g:unknown");
  });
});
