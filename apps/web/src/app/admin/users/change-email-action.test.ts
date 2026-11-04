// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdmin } from "@/lib/authz/require-admin";
import { getCurrentSubject } from "@/lib/authz/subject";
import { GUEST_SUBJECT } from "@/lib/authz/types";
import { hashEmailKey } from "@/lib/auth/tokens";
import { changeUserEmailAction } from "./actions";

/**
 * 管理员代改邮箱动作（M11.3 清账）：操作者归属、各结果码的提示、旧地址告警的发送条件、发信失败的反馈。
 * 服务层（changeEmailAddress）的事务行为由 lib/auth/admin-email-change.int.test.ts 用真实 MySQL 覆盖，
 * 这里只验证动作如何编排它。
 */

const mocks = vi.hoisted(() => ({
  change: vi.fn(),
  rateLimit: vi.fn(),
  trySendMail: vi.fn(),
  securityOn: vi.fn(),
}));
vi.mock("@/modules", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/net/client-ip", () => ({ clientIpFrom: () => "203.0.113.7" }));
vi.mock("@/lib/auth/session", () => ({
  getPasswordChangeUser: async () => null,
  getCurrentUser: vi.fn(),
}));
vi.mock("@/lib/authz/require-admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/authz/subject", () => ({ getCurrentSubject: vi.fn() }));
vi.mock("@/lib/authz/restrictions-admin", () => ({
  createRestriction: vi.fn(),
  liftRestriction: vi.fn(),
  revokeUserSessionByAdmin: vi.fn(),
}));
vi.mock("@/lib/authz/admin", async (original) => ({
  ...(await original<typeof import("@/lib/authz/admin")>()),
  assignUserRole: vi.fn(),
  revokeUserRole: vi.fn(),
}));
vi.mock("@/lib/authz/team-role-mapping", () => ({ isTeamMembershipRole: () => false }));
vi.mock("@/lib/authz/team-membership", () => ({
  assignTeamMembership: vi.fn(),
  revokeTeamMembership: vi.fn(),
}));
vi.mock("@/lib/authz/appeals", () => ({
  AppealError: class AppealError extends Error {},
  resolveUserAppeal: vi.fn(),
}));
vi.mock("@/lib/auth/email-change", () => ({ changeEmailAddress: mocks.change }));
vi.mock("@/lib/auth/ratelimit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/notifications/email", () => ({ securityEmailEnabled: mocks.securityOn }));
vi.mock("@/lib/mail", () => ({
  getMailBrand: async () => ({ siteUrl: "https://forum.test", siteName: "测试站" }),
  trySendMail: mocks.trySendMail,
  emailChangedAlertMail: () => "ALERT",
  emailChangedConfirmMail: () => "CONFIRM",
  verifyEmailMail: (link: string) => `VERIFY:${link}`,
}));

const ADMIN_ID = 91;
const changed = (over: Record<string, unknown> = {}) => ({
  kind: "changed",
  beforeEmail: "old@example.com",
  emailChanged: true,
  previouslyVerified: false,
  verifyToken: "tok123",
  ...over,
});

/** 提交表单并取出重定向地址（redirect 以抛出带 digest 的异常实现） */
async function submit(fields: Record<string, string>): Promise<string> {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  try {
    await changeUserEmailAction(data);
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    const m = digest.match(/^NEXT_REDIRECT;[a-z]+;(.+);\d{3};$/);
    if (m) return m[1]!;
    throw error;
  }
  throw new Error("动作应以重定向结束");
}
const errorUrl = (message: string) => `/admin/users/43?error=${encodeURIComponent(message)}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentSubject).mockResolvedValue({ ...GUEST_SUBJECT, userId: 7 });
  vi.mocked(requireAdmin).mockResolvedValue({ userId: ADMIN_ID, ip: "198.51.100.91" });
  mocks.securityOn.mockResolvedValue(true);
  mocks.rateLimit.mockReturnValue({ allowed: true });
  mocks.trySendMail.mockResolvedValue(true);
  mocks.change.mockResolvedValue(changed());
});

describe("changeUserEmailAction", () => {
  it("先过后台权限门（admin.users），再调服务；操作者是管理员，邮箱去空格并归一化为小写键", async () => {
    await submit({ userId: "43", email: "  Right@Example.COM " });
    expect(requireAdmin).toHaveBeenCalledExactlyOnceWith("admin.users");
    expect(requireAdmin).toHaveBeenCalledBefore(mocks.change);
    const [userId, email, key, ip, allow, audit] = mocks.change.mock.calls[0]!;
    expect([userId, email, key, ip]).toEqual([
      43,
      "Right@Example.COM",
      "right@example.com",
      "198.51.100.91",
    ]);
    expect(audit).toEqual({ actorId: ADMIN_ID, action: "admin.user.email.change" });
    // 目标地址限流回调：按归一化键的哈希限流，每小时 5 次
    expect((allow as () => boolean)()).toBe(true);
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      `email-change-to:${hashEmailKey("right@example.com")}`,
      5,
      3_600_000,
    );
  });

  it("邮箱格式不对 → 提示错误，不调用服务也不发信", async () => {
    expect(await submit({ userId: "43", email: "not-an-email" })).toBe(errorUrl("邮箱格式不正确"));
    expect(await submit({ userId: "43", email: "   " })).toBe(errorUrl("邮箱格式不正确"));
    expect(mocks.change).not.toHaveBeenCalled();
    expect(mocks.trySendMail).not.toHaveBeenCalled();
  });

  it.each([
    ["taken", "该邮箱已被其他账号使用"],
    ["rate_limited", "该地址的验证邮件发送过于频繁，请稍后再试"],
    ["missing", "账号不存在、已注销或正在注销，不能修改邮箱"],
    ["unchanged", "邮箱未变化：该账号邮箱已验证"],
  ])("服务返回 %s → 页面提示对应错误且不发任何邮件", async (kind, message) => {
    mocks.change.mockResolvedValue({ kind });
    expect(await submit({ userId: "43", email: "a@example.com" })).toBe(errorUrl(message));
    expect(mocks.trySendMail).not.toHaveBeenCalled();
  });

  it("从未验证过的账号（含登录门账号）：只发验证邮件到新地址，不给旧地址发告警、不发确认", async () => {
    const url = await submit({ userId: "43", email: "right@example.com" });
    expect(url).toBe("/admin/users/43?emailChanged=sent");
    expect(mocks.trySendMail.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["right@example.com", "VERIFY:https://forum.test/verify/tok123"],
    ]);
  });

  it("验证过的账号且安全通知开启：旧地址告警 + 新地址确认 + 验证邮件", async () => {
    mocks.change.mockResolvedValue(changed({ previouslyVerified: true }));
    await submit({ userId: "43", email: "right@example.com" });
    expect(mocks.trySendMail.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["old@example.com", "ALERT"],
      ["right@example.com", "CONFIRM"],
      ["right@example.com", "VERIFY:https://forum.test/verify/tok123"],
    ]);
    // 每封信都记在被改账号名下（email_log 按用户归属），而不是管理员
    expect(mocks.trySendMail.mock.calls.every((c) => c[2]?.userId === 43)).toBe(true);
  });

  it("验证过的账号但站点关闭安全通知：只发验证邮件", async () => {
    mocks.securityOn.mockResolvedValue(false);
    mocks.change.mockResolvedValue(changed({ previouslyVerified: true }));
    await submit({ userId: "43", email: "right@example.com" });
    expect(mocks.trySendMail.mock.calls.map((c) => c[1])).toEqual([
      "VERIFY:https://forum.test/verify/tok123",
    ]);
  });

  it("邮箱没变（未验证账号重发）时不给旧地址发告警，即使它曾被验证过", async () => {
    mocks.change.mockResolvedValue(changed({ previouslyVerified: true, emailChanged: false }));
    await submit({ userId: "43", email: "old@example.com" });
    const targets = mocks.trySendMail.mock.calls.map((c) => [c[0], c[1]]);
    expect(targets).not.toContainEqual(["old@example.com", "ALERT"]);
  });

  it("验证邮件发送失败 → 邮箱已改但页面给出警示参数 emailChanged=failed", async () => {
    mocks.trySendMail.mockResolvedValue(false);
    expect(await submit({ userId: "43", email: "right@example.com" })).toBe(
      "/admin/users/43?emailChanged=failed",
    );
  });
});
