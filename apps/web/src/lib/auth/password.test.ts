import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildLegacyStorage,
  hashPassword,
  legacyHashHex,
  verifyLegacyPassword,
  verifyPassword,
} from "./password";

describe("password (argon2id)", () => {
  it("哈希往返正确", async () => {
    const h = await hashPassword("青翼密码Pass1!");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "青翼密码Pass1!")).toBe(true);
  });

  it("错误密码拒绝", async () => {
    const h = await hashPassword("correct");
    expect(await verifyPassword(h, "wrong")).toBe(false);
  });

  it("同密码两次哈希不同盐", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("损坏哈希串返回 false 而非抛错", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});

describe("双轨旧哈希（M10.6c，phpwind 口径 md5(md5(pwd)+salt)）", () => {
  const pw = "旧密码Pass1";
  const salt = "YcNESh"; // 旧库 SkyJourney 同款 6 位盐格式
  // 独立于 legacyHashHex 直接重算，避免实现互相印证的循环论证
  const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

  it("口径向量：与旧站 WindidUtility::buildPassword 一致", () => {
    expect(legacyHashHex(pw, salt)).toBe(md5(md5(pw) + salt));
    expect(legacyHashHex("中文密码", "Ab3dEf")).toBe(md5(md5("中文密码") + "Ab3dEf"));
  });

  it("存储格式往返：buildLegacyStorage → verifyLegacyPassword", () => {
    const stored = buildLegacyStorage(legacyHashHex(pw, salt), salt);
    expect(stored).toBe(`md5$${md5(md5(pw) + salt)}$${salt}`);
    expect(verifyLegacyPassword(stored, pw)).toBe(true);
    expect(verifyLegacyPassword(stored, pw + "x")).toBe(false);
    expect(verifyLegacyPassword(stored, "")).toBe(false);
  });

  it("坏材料一律 false（格式/标签/哈希长度/空盐）", () => {
    expect(verifyLegacyPassword("md5$abc$Yc", pw)).toBe(false);
    expect(verifyLegacyPassword("argon2$xxxx$YcNESh", pw)).toBe(false);
    expect(verifyLegacyPassword(`md5$${"0".repeat(32)}$`, pw)).toBe(false);
    expect(verifyLegacyPassword("garbage", pw)).toBe(false);
  });
});
