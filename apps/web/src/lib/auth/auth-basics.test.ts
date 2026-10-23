import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "./token";
import { legacyAvatarPath, legacyAvatarUrl } from "./avatar";

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

describe("legacyAvatarPath（旧站头像算法，双实证样本）", () => {
  it("uid 20709 → 000/02/07（实测样本）", () => {
    expect(legacyAvatarPath(20709, "_middle")).toBe("avatar/000/02/07/20709_middle.jpg");
  });

  it("uid 25940 → 000/02/59（实测样本）", () => {
    expect(legacyAvatarPath(25940, "")).toBe("avatar/000/02/59/25940.jpg");
  });

  it("小 uid 补零正确（3940 → 000/00/39）", () => {
    expect(legacyAvatarPath(3940, "_small")).toBe("avatar/000/00/39/3940_small.jpg");
  });

  it("URL 前缀走 /attachment 静态路由", () => {
    expect(legacyAvatarUrl(20709)).toBe("/attachment/avatar/000/02/07/20709_middle.jpg");
  });
});
