// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { getWebDb, notificationPreferences, userProfiles } from "@funwind/db";
import { getCurrentUser } from "@/lib/auth/session";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { takePreferenceRateLimit } from "@/lib/auth/preference-ratelimit";
import { isKnownPackId } from "@/lib/theme/catalog";
import { updatePmPolicyAction } from "@/app/actions/pm";
import { PATCH } from "@/app/api/settings/preferences/route";
import { toggleNotifPrefAction, updateThemePackAction } from "./actions";

const writes = vi.hoisted(() => ({
  insert: vi.fn(),
  values: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
}));
vi.mock("@funwind/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@funwind/db")>()),
  getWebDb: vi.fn(() => ({ insert: writes.insert, update: writes.update })),
}));
vi.mock("@/lib/actions/define-action", () => ({
  // 仅执行偏好业务体；鉴权和 schema 的统一骨架由 define-action.test.ts 覆盖。
  defineAction:
    (def: { run: (ctx: unknown, input: unknown) => Promise<void> }) => (input: unknown) =>
      def.run({ userId: 42, subject: { userId: 42 } }, input),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(),
  getPasswordChangeUser: vi.fn(),
  revokeOtherSessionsInTx: vi.fn(),
  MUST_CHANGE_COOKIE: "must-change",
  SESSION_COOKIE: "session",
}));
vi.mock("@/lib/theme/catalog", () => ({ isKnownPackId: vi.fn() }));
vi.mock("@/lib/pm/service", () => ({ sendMessage: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAudit: vi.fn() }));
vi.mock("@/lib/authz/service", () => ({ checkPermission: vi.fn() }));
vi.mock("@/lib/auth/password", () => ({
  hashPassword: vi.fn(),
  verifyLegacyPassword: vi.fn(),
  verifyPassword: vi.fn(),
}));
vi.mock("@/lib/auth/email", () => ({ isValidEmail: vi.fn() }));
vi.mock("@/lib/notifications/email", () => ({
  securityEmailEnabled: vi.fn(),
  sendUserEmail: vi.fn(),
}));
vi.mock("@/lib/mail", () => ({
  emailChangedAlertMail: vi.fn(),
  emailChangedConfirmMail: vi.fn(),
  getMailBrand: vi.fn(),
  passwordChangedMail: vi.fn(),
  trySendMail: vi.fn(),
  verifyEmailMail: vi.fn(),
}));
vi.mock("@/lib/auth/tokens", () => ({ hashEmailKey: vi.fn(), issueEmailToken: vi.fn() }));
vi.mock("@/lib/auth/email-change", () => ({ changeEmailAddress: vi.fn() }));

const formInput = (input: Record<string, unknown>) => input as unknown as FormData;
const request = (body: unknown) =>
  new Request("http://localhost:3100/api/settings/preferences", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const fillQuota = () => {
  for (let i = 0; i < 60; i++) takePreferenceRateLimit(42);
};
const noWrites = () => {
  expect(getWebDb).not.toHaveBeenCalled();
  expect(writes.insert).not.toHaveBeenCalled();
  expect(writes.update).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
};
const themeError = (text: string) => `/settings/appearance?error=${encodeURIComponent(text)}`;

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimiter();
  vi.mocked(getCurrentUser).mockResolvedValue({
    id: 42,
    username: "u42",
    email: null,
    emailVerified: false,
    passwordHashIsSet: false,
  });
  vi.mocked(isKnownPackId).mockImplementation(async (pack) => ["default", "qy2010"].includes(pack));
  writes.insert.mockReturnValue({ values: writes.values });
  writes.values.mockReturnValue({ onDuplicateKeyUpdate: writes.upsert });
  writes.upsert.mockResolvedValue(undefined);
  writes.update.mockReturnValue({ set: writes.set });
  writes.set.mockReturnValue({ where: writes.where });
  writes.where.mockResolvedValue(undefined);
});

describe("偏好表单入口复用服务", () => {
  it.each(["qy2010", "site"])("主题 %s 只查一次目录并保留原成功回跳", async (pack) => {
    await expect(updateThemePackAction(formInput({ pack }))).rejects.toThrow(
      "/settings/appearance?saved=1",
    );
    const stored = pack === "site" ? null : pack;
    expect(writes.insert).toHaveBeenCalledExactlyOnceWith(userProfiles);
    expect(writes.values).toHaveBeenCalledExactlyOnceWith({ userId: 42, themePack: stored });
    expect(writes.upsert).toHaveBeenCalledExactlyOnceWith({ set: { themePack: stored } });
    if (stored === null) expect(isKnownPackId).not.toHaveBeenCalled();
    else expect(isKnownPackId).toHaveBeenCalledExactlyOnceWith(stored);
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/", "layout");
  });

  it("无效或停用主题保留原错误回跳，目录只检验一次，不写库", async () => {
    await expect(updateThemePackAction(formInput({ pack: "disabled-pack" }))).rejects.toThrow(
      themeError("未知的主题包"),
    );
    expect(isKnownPackId).toHaveBeenCalledExactlyOnceWith("disabled-pack");
    noWrites();
  });

  it.each(["all", "following", "off"])(
    "私信 %s 经共享 update 服务并保留原保存提示",
    async (policy) => {
      await expect(updatePmPolicyAction(formInput({ policy }))).rejects.toThrow(
        "/me?notice=pm-policy-saved",
      );
      expect(writes.update).toHaveBeenCalledExactlyOnceWith(userProfiles);
      expect(writes.set).toHaveBeenCalledExactlyOnceWith({ pmPolicy: policy });
      expect(writes.where).toHaveBeenCalledOnce();
      expect(writes.insert).not.toHaveBeenCalled();
      expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/me");
    },
  );

  it("通知仍只写单格并保留原回跳", async () => {
    await expect(
      toggleNotifPrefAction(formInput({ type: "reply", channel: "email", enabled: "off" })),
    ).rejects.toThrow("/settings/notifications");
    expect(writes.insert).toHaveBeenCalledExactlyOnceWith(notificationPreferences);
    expect(writes.values).toHaveBeenCalledExactlyOnceWith({
      userId: 42,
      type: "reply",
      channel: "email",
      enabled: false,
    });
    expect(writes.upsert).toHaveBeenCalledExactlyOnceWith({ set: { enabled: false } });
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/settings/notifications");
  });
});

describe("PATCH 与三类表单共用额度", () => {
  const entries = [
    {
      name: "主题",
      action: () => updateThemePackAction(formInput({ pack: "qy2010" })),
      success: "/settings/appearance?saved=1",
      blocked: themeError("操作过于频繁，请稍后再试"),
    },
    {
      name: "私信",
      action: () => updatePmPolicyAction(formInput({ policy: "off" })),
      success: "/me?notice=pm-policy-saved",
      blocked: "/settings/pm?notice=preferences-rate",
    },
    {
      name: "通知",
      action: () =>
        toggleNotifPrefAction(formInput({ type: "reply", channel: "email", enabled: "off" })),
      success: "/settings/notifications",
      blocked: "/settings/notifications?notice=preferences-rate",
    },
  ];

  it.each(entries)(
    "$name：额度耗尽不调用服务，不写库；回跳现有错误反馈入口",
    async ({ action, blocked }) => {
      fillQuota();
      await expect(action()).rejects.toThrow(blocked);
      expect(isKnownPackId).not.toHaveBeenCalled();
      noWrites();
    },
  );

  it.each(entries)("$name：PATCH 消耗 60 次后，表单不能另起桶绕过", async ({ action, blocked }) => {
    for (let i = 0; i < 60; i++) {
      expect((await PATCH(request({ kind: "pmPolicy", pmPolicy: "all" }))).status).toBe(200);
    }
    vi.clearAllMocks();
    await expect(action()).rejects.toThrow(blocked);
    expect(isKnownPackId).not.toHaveBeenCalled();
    noWrites();
  });

  it.each(entries)(
    "$name：表单消耗 60 次后，PATCH 返回 429 且不写库",
    async ({ action, success }) => {
      for (let i = 0; i < 60; i++) await expect(action()).rejects.toThrow(success);
      vi.clearAllMocks();
      const response = await PATCH(request({ kind: "themePack", pack: "qy2010" }));
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "rate_limited" });
      expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(isKnownPackId).not.toHaveBeenCalled();
      noWrites();
    },
  );
});
