// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AdminError } from "@/lib/authz/admin";
import {
  ADMIN_API_TOKEN_DAYS,
  ADMIN_API_TOKEN_DEFAULT_DAYS,
  ADMIN_API_TOKEN_LIMIT,
  buildPlainToken,
  ensureTokenDurationDays,
  ensureTokenName,
  tokenSuffixOf,
} from "./tokens";

describe("管理 token 纯逻辑（M20 Service）", () => {
  it("buildPlainToken：fw_at_ 前缀 + 43 字符 base64url，库内 id = SHA-256(明文)，两次签发不同", () => {
    const a = buildPlainToken();
    expect(a.plain).toMatch(/^fw_at_[A-Za-z0-9_-]{43}$/);
    expect(a.id).toBe(createHash("sha256").update(a.plain).digest("hex"));
    const b = buildPlainToken();
    expect(b.plain).not.toBe(a.plain);
    expect(b.id).not.toBe(a.id);
  });

  it("tokenSuffixOf：明文尾 8 字符（列表辨识用）", () => {
    expect(tokenSuffixOf(`fw_at_${"a".repeat(35)}12345678`)).toBe("12345678");
  });

  it("有效期档位（D2）：30/90/180/365 放行，默认 90，900/0/NaN 抛 AdminError", () => {
    for (const days of ADMIN_API_TOKEN_DAYS) {
      expect(ensureTokenDurationDays(days)).toBe(days);
    }
    expect(ADMIN_API_TOKEN_DEFAULT_DAYS).toBe(90);
    for (const bad of [0, 7, 91, 900, Number.NaN, 365.5]) {
      expect(() => ensureTokenDurationDays(bad)).toThrow(AdminError);
    }
  });

  it("名称校验：trim 后 1–64 字符放行，空白/超长抛 AdminError", () => {
    expect(ensureTokenName("  CI 脚本  ")).toBe("CI 脚本");
    expect(ensureTokenName("x".repeat(64)).length).toBe(64);
    expect(() => ensureTokenName("   ")).toThrow(AdminError);
    expect(() => ensureTokenName("x".repeat(65))).toThrow(AdminError);
  });

  it("上限常量与档位清单保持契约（D2/D5 定案锚定）", () => {
    expect(ADMIN_API_TOKEN_LIMIT).toBe(5);
    expect([...ADMIN_API_TOKEN_DAYS]).toEqual([30, 90, 180, 365]);
  });
});
