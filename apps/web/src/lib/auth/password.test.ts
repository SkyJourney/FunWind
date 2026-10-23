import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

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
