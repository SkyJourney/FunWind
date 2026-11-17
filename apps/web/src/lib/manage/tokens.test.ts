// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AdminError } from "@/lib/authz/admin-error";
import {
  ADMIN_API_TOKEN_DAYS,
  ADMIN_API_TOKEN_DEFAULT_DAYS,
  ADMIN_API_TOKEN_LIMIT,
  buildPlainToken,
  ensureTokenDurationDays,
  ensureTokenName,
  resetPendingPlains,
  stashPlainForOnce,
  takePlainOnce,
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

describe("签发明文一次性暂存（M20 审查补测：命中即删 / TTL / 持有人绑定）", () => {
  it("命中即删：第二次取走返回 null（刷新不重放）", () => {
    resetPendingPlains();
    stashPlainForOnce("tok-1", "fw_at_plain", 90004);
    expect(takePlainOnce("tok-1", 90004)).toBe("fw_at_plain");
    expect(takePlainOnce("tok-1", 90004)).toBeNull();
  });

  it("持有人绑定：另一位管理员凭同一 id 取不走，且不消费签发人的一次性机会", () => {
    resetPendingPlains();
    stashPlainForOnce("tok-2", "fw_at_plain", 90004);
    expect(takePlainOnce("tok-2", 91001)).toBeNull();
    expect(takePlainOnce("tok-2", 90004)).toBe("fw_at_plain");
  });

  it("TTL 过期失效（fake timers 推进 61 秒后取走为 null）", () => {
    vi.useFakeTimers();
    try {
      resetPendingPlains();
      stashPlainForOnce("tok-3", "fw_at_plain", 90004);
      expect(takePlainOnce("tok-3", 90004)).toBe("fw_at_plain"); // 60s 内可取
      vi.advanceTimersByTime(61_000);
      stashPlainForOnce("tok-4", "fw_at_later", 90004);
      // tok-3 已被下一次签发的过期清扫顺带清掉；tok-4 正常可用
      expect(takePlainOnce("tok-3", 90004)).toBeNull();
      expect(takePlainOnce("tok-4", 90004)).toBe("fw_at_later");
      vi.advanceTimersByTime(61_000);
      expect(takePlainOnce("tok-4", 90004)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("容量上限：32 条满时丢最旧（签发低频，仅防泄漏）", () => {
    resetPendingPlains();
    for (let i = 0; i < 32; i++) stashPlainForOnce(`tok-a${i}`, `p${i}`, 90004);
    stashPlainForOnce("tok-new", "p-new", 90004);
    expect(takePlainOnce("tok-a0", 90004)).toBeNull();
    expect(takePlainOnce("tok-new", 90004)).toBe("p-new");
  });
});
