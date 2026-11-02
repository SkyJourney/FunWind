import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildLegacyStorage,
  hashPassword,
  legacyHashHex,
  verifyAccountPassword,
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

describe("标识符密码复验 · 共用现代哈希入口", () => {
  it("真实哈希恰好校验一次并原样传入密码，默认校验器保留真实往返", async () => {
    const password = "共用入口Pass42!";
    const hash = await hashPassword(password);
    const verifier = vi.fn(verifyPassword);
    expect(await verifyAccountPassword(hash, password, verifier)).toBe(true);
    expect(verifier).toHaveBeenCalledExactlyOnceWith(hash, password);
    expect(await verifyAccountPassword(hash, password)).toBe(true);
    expect(await verifyAccountPassword(hash, "wrong-password")).toBe(false);
  });

  it.each([null, ""])(
    "现代哈希缺失（%s）时只校验一次同参数 dummy，且不能认证成功",
    async (hash) => {
      const password = "missing-password";
      const verifier = vi.fn(verifyPassword);
      expect(await verifyAccountPassword(hash, password, verifier)).toBe(false);
      expect(verifier).toHaveBeenCalledTimes(1);
      const [dummy, receivedPassword] = verifier.mock.calls[0]!;
      expect(receivedPassword).toBe(password);
      expect(dummy).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      const real = await hashPassword(password);
      expect(dummy.split("$").slice(1, 4)).toEqual(real.split("$").slice(1, 4));
      expect(dummy).not.toBe(real);
    },
  );

  it("dummy 即使实际匹配，或校验器恒返回 true，缺少现代哈希仍拒绝", async () => {
    const verifier = vi.fn(verifyPassword);
    const dummyPassword = "funwind-public-dummy-password-check";
    expect(await verifyAccountPassword(null, dummyPassword, verifier)).toBe(false);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(await verifier.mock.results[0]!.value).toBe(true);

    const alwaysTrue = vi.fn(async () => true);
    expect(await verifyAccountPassword(null, "任何密码", alwaysTrue)).toBe(false);
    expect(alwaysTrue).toHaveBeenCalledTimes(1);
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
