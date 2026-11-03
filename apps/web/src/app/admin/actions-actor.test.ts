// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { getWebDb } from "@funwind/db";
import { GUEST_SUBJECT } from "@/lib/authz/types";
import { getCurrentSubject } from "@/lib/authz/subject";
import { requireAdmin } from "@/lib/authz/require-admin";
import * as contents from "./contents/actions";
import * as review from "./review/actions";
import * as poll from "./poll/actions";
import * as reports from "./reports/actions";
import * as pm from "./pm/actions";
import * as users from "./users/actions";
import * as settings from "./settings/actions";
import * as themes from "./themes/actions";

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
  hide: vi.fn(),
  disable: vi.fn(),
  flags: vi.fn(),
  closePoll: vi.fn(),
  deletePoll: vi.fn(),
  reopenPoll: vi.fn(),
  handleReport: vi.fn(),
  dismissReports: vi.fn(),
  deleteMessage: vi.fn(),
  createRestriction: vi.fn(),
  liftRestriction: vi.fn(),
  revokeSession: vi.fn(),
  assignRole: vi.fn(),
  revokeRole: vi.fn(),
  assignTeam: vi.fn(),
  revokeTeam: vi.fn(),
  resolveAppeal: vi.fn(),
  setSetting: vi.fn(),
  toggleTheme: vi.fn(),
  deleteTheme: vi.fn(),
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
vi.mock("@/lib/moderation/review", () => ({
  approveReview: mocks.approve,
  rejectReview: mocks.reject,
  hidePost: mocks.hide,
  disableContent: mocks.disable,
}));
vi.mock("@/lib/moderation/contents", () => ({ setThreadFlags: mocks.flags }));
vi.mock("@/lib/poll/admin", () => ({
  closePoll: mocks.closePoll,
  deletePoll: mocks.deletePoll,
  reopenPoll: mocks.reopenPoll,
}));
vi.mock("@/lib/reports/service", () => ({
  handleReport: mocks.handleReport,
  dismissReportsBulk: mocks.dismissReports,
}));
vi.mock("@/lib/pm/admin", () => ({ deleteMessage: mocks.deleteMessage }));
vi.mock("@/lib/authz/restrictions-admin", () => ({
  createRestriction: mocks.createRestriction,
  liftRestriction: mocks.liftRestriction,
  revokeUserSessionByAdmin: mocks.revokeSession,
}));
vi.mock("@/lib/authz/admin", async (original) => ({
  ...(await original<typeof import("@/lib/authz/admin")>()),
  assignUserRole: mocks.assignRole,
  revokeUserRole: mocks.revokeRole,
}));
vi.mock("@/lib/authz/team-role-mapping", () => ({
  isTeamMembershipRole: (key: string) => key === "team-role",
}));
vi.mock("@/lib/authz/team-membership", () => ({
  assignTeamMembership: mocks.assignTeam,
  revokeTeamMembership: mocks.revokeTeam,
}));
vi.mock("@/lib/authz/appeals", () => ({
  AppealError: class AppealError extends Error {},
  resolveUserAppeal: mocks.resolveAppeal,
}));
vi.mock("@/lib/auth/settings", () => ({ setSetting: mocks.setSetting }));
vi.mock("@/lib/limits/load", () => ({ getLimitsConfig: vi.fn() }));
vi.mock("@/lib/limits/config", () => ({ limitsConfigSchema: { safeParse: vi.fn() } }));
vi.mock("@/lib/chrome/site-chrome", () => ({ invalidateSiteChrome: vi.fn() }));
vi.mock("@/lib/mail", () => ({ getMailBrand: vi.fn(), sendMail: vi.fn(), testMail: vi.fn() }));
vi.mock("@/lib/theme/apply-pack-logo", () => ({ tryApplyThemePackLogo: vi.fn() }));
vi.mock("@/lib/brand/decor-pool", () => ({ getDecorPoolRaw: vi.fn() }));
vi.mock("@/lib/theme/packs", () => ({
  copyThemePack: vi.fn(),
  createThemePack: vi.fn(),
  deleteThemePack: mocks.deleteTheme,
  getThemePackDecorRefs: vi.fn(),
  setSiteDefaultThemePack: vi.fn(),
  setThemePackEnabled: mocks.toggleTheme,
  updateThemePack: vi.fn(),
}));
vi.mock("@funwind/db", async (original) => ({
  ...(await original<typeof import("@funwind/db")>()),
  getWebDb: vi.fn(() => ({
    select: () => ({ from: () => ({ where: async () => [{ threadId: 73 }] }) }),
  })),
}));

const subject = { ...GUEST_SUBJECT, userId: 7 };
const memberActor = { userId: 7, via: "admin", ip: "203.0.113.7" };
const adminActor = { userId: 91, via: "admin", ip: "198.51.100.91" };
const reason = "  核对 & 理由  ";
const memberCases = [
  {
    action: contents.disableContentAction,
    service: mocks.disable,
    fields: { postId: "57", reason },
    args: [subject, 57, reason, memberActor],
  },
  {
    action: contents.approveContentAction,
    service: mocks.approve,
    fields: { postId: "57" },
    args: [subject, 57, memberActor],
  },
  {
    action: contents.rejectContentAction,
    service: mocks.reject,
    fields: { postId: "57", reason },
    args: [subject, 57, reason, memberActor],
  },
  {
    action: contents.hideContentAction,
    service: mocks.hide,
    fields: { postId: "57", reason },
    args: [subject, 57, reason, memberActor],
  },
  {
    action: contents.threadFlagsAction,
    service: mocks.flags,
    fields: { threadId: "73", locked: "1" },
    args: [subject, 73, { locked: true }, memberActor],
  },
  {
    action: review.approveReviewAction,
    service: mocks.approve,
    fields: { postId: "57" },
    args: [subject, 57, memberActor],
  },
  {
    action: review.rejectReviewAction,
    service: mocks.reject,
    fields: { postId: "57", reason },
    args: [subject, 57, reason, memberActor],
  },
  {
    action: review.hidePostAction,
    service: mocks.hide,
    fields: { postId: "57", reason },
    args: [subject, 57, reason, memberActor],
  },
  {
    action: review.approveReviewBulkAction,
    service: mocks.approve,
    fields: { postIds: "57" },
    args: [subject, 57, memberActor],
  },
  {
    action: review.rejectReviewBulkAction,
    service: mocks.reject,
    fields: { postIds: "57", reason },
    args: [subject, 57, reason, memberActor],
  },
  {
    action: poll.closePollAction,
    service: mocks.closePoll,
    fields: { pollId: "13" },
    args: [memberActor, 13],
  },
  {
    action: poll.deletePollAction,
    service: mocks.deletePoll,
    fields: { pollId: "13" },
    args: [memberActor, 13],
  },
  {
    action: poll.reopenPollAction,
    service: mocks.reopenPoll,
    fields: { pollId: "13" },
    args: [memberActor, 13],
  },
];
const adminCases = [
  {
    action: reports.handleReportAction,
    service: mocks.handleReport,
    permission: "admin.reports",
    fields: { reportId: "21", outcome: "resolved", note: reason },
    args: [adminActor, 21, "resolved", reason],
  },
  {
    action: reports.dismissReportBulkAction,
    service: mocks.dismissReports,
    permission: "admin.reports",
    fields: { reportIds: "21" },
    args: [adminActor, [21]],
  },
  {
    action: pm.deleteMessageAction,
    service: mocks.deleteMessage,
    permission: "site.admin",
    fields: { messageId: "31", reason },
    args: [adminActor, 31, reason],
  },
  {
    action: users.createRestrictionAction,
    service: mocks.createRestriction,
    permission: "admin.users",
    fields: { userId: "43", kind: "mute", reason },
    args: [adminActor, { userId: 43, kind: "mute", scopeId: 0, reason, endsAt: null }],
  },
  {
    action: users.liftRestrictionAction,
    service: mocks.liftRestriction,
    permission: "admin.users",
    fields: { userId: "43", restrictionId: "51", note: reason },
    args: [adminActor, 51, reason],
  },
  {
    action: users.assignRoleAction,
    service: mocks.assignRole,
    permission: "admin.users",
    fields: { userId: "43", roleKey: "custom", reason },
    args: [adminActor, 43, "custom", 0, null, reason.trim()],
  },
  {
    action: users.assignRoleAction,
    service: mocks.assignTeam,
    permission: "admin.users",
    fields: { userId: "43", roleKey: "team-role", reason },
    args: [
      adminActor,
      { userId: 43, roleKey: "team-role", expiresAt: null, reason: reason.trim() },
    ],
  },
  {
    action: users.revokeRoleAction,
    service: mocks.revokeRole,
    permission: "admin.users",
    fields: { userId: "43", roleKey: "custom", reason },
    args: [adminActor, 43, "custom", 0, reason.trim()],
  },
  {
    action: users.revokeRoleAction,
    service: mocks.revokeTeam,
    permission: "admin.users",
    fields: { userId: "43", roleKey: "team-role", reason },
    args: [adminActor, 43, "team-role", reason.trim()],
  },
  {
    action: users.revokeUserSessionAction,
    service: mocks.revokeSession,
    permission: "admin.users",
    fields: { userId: "43", sessionId: "a".repeat(64) },
    args: [adminActor, 43, "a".repeat(64)],
  },
  {
    action: users.resolveUserAppealAction,
    service: mocks.resolveAppeal,
    permission: "admin.users",
    fields: { userId: "43", appealId: "61", status: "approved", result: reason },
    args: [adminActor, 61, "approved", reason.trim()],
  },
  {
    action: settings.saveIdentityAction,
    service: mocks.setSetting,
    permission: "site.admin",
    fields: { name: "测试站", url: "https://example.test/" },
    args: [
      "site.identity",
      { name: "测试站", tagline: "", url: "https://example.test" },
      adminActor,
    ],
  },
  {
    action: settings.saveRegisterModeAction,
    service: mocks.setSetting,
    permission: "site.admin",
    fields: { mode: "invite" },
    args: ["register.mode", { mode: "invite" }, adminActor],
  },
  {
    action: settings.saveEmailVerificationAction,
    service: mocks.setSetting,
    permission: "site.admin",
    fields: { mode: "always" },
    args: ["email.verification", { mode: "always" }, adminActor],
  },
  {
    action: settings.saveEmailSecurityAction,
    service: mocks.setSetting,
    permission: "site.admin",
    fields: { enabled: "on" },
    args: ["email.security", { enabled: true }, adminActor],
  },
  {
    action: settings.saveDigestHourAction,
    service: mocks.setSetting,
    permission: "site.admin",
    fields: { hour: "8" },
    args: ["email.digest", { hour: 8 }, adminActor],
  },
  {
    action: themes.toggleThemePackAction,
    service: mocks.toggleTheme,
    permission: "site.admin",
    fields: { id: "unit-pack", enabled: "1" },
    args: ["unit-pack", true, adminActor],
  },
  {
    action: themes.deleteThemePackAction,
    service: mocks.deleteTheme,
    permission: "site.admin",
    fields: { id: "unit-pack" },
    args: ["unit-pack", adminActor],
  },
];

function form(fields: Record<string, string | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data.set(key, value);
  }
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentSubject).mockResolvedValue(subject);
  vi.mocked(requireAdmin).mockResolvedValue({ userId: 91, ip: "198.51.100.91" });
  for (const service of Object.values(mocks)) service.mockResolvedValue({ ok: true });
  mocks.dismissReports.mockResolvedValue({ ok: 1, failed: 0 });
});

describe("拥有的后台动作统一审计操作者", () => {
  it.each(memberCases)("登录入口 %# 保留主体、参数和 admin 审计来源", async (entry) => {
    await expect(entry.action(form(entry.fields))).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT;"),
    });
    expect(entry.service.mock.calls).toEqual([entry.args]);
    expect(requireAdmin).not.toHaveBeenCalled();
  });

  it.each(adminCases)("管理入口 %# 沿用原权限门结果中的用户与 IP", async (entry) => {
    await expect(entry.action(form(entry.fields))).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT;"),
    });
    expect(entry.service.mock.calls).toEqual([entry.args]);
    expect(requireAdmin).toHaveBeenCalledExactlyOnceWith(entry.permission);
    expect(requireAdmin).toHaveBeenCalledBefore(entry.service);
    expect(getWebDb).not.toHaveBeenCalled();
  });

  it.each(memberCases)("游客不能借入口 %# 生成零号操作者或写审计", async (entry) => {
    vi.mocked(getCurrentSubject).mockResolvedValue(GUEST_SUBJECT);
    await expect(entry.action(form(entry.fields))).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    expect(entry.service).not.toHaveBeenCalled();
    expect(getWebDb).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
