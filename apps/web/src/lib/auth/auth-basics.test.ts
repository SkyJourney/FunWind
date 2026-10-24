import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "./token";

describe("token", () => {
  it("生成 URL-safe 随机令牌（43 字符 base64url）", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t).not.toBe(generateToken());
  });

  it("哈希为 64 位十六进制且确定性", () => {
    expect(hashToken("abc")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});
