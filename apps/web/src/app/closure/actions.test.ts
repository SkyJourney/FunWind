// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWebDb } from "@funwind/db";
import { GUEST_SUBJECT } from "@/lib/authz/types";
import { requireAdmin } from "@/lib/authz/require-admin";
import { rateLimit } from "@/lib/auth/ratelimit";
import { hashEmailKey } from "@/lib/auth/tokens";
import {
  issueAccountDeletionAccessForEmail,
  issueAccountDeletionRequestForEmail,
} from "@/lib/auth/account-deletion";
import { accountDeletionVerificationMail, getMailBrand, trySendMail } from "@/lib/mail";
import { sendClosureAccessEmailAction, sendClosureRequestEmailAction } from "./actions";

const mocks = vi.hoisted(() => ({
  ip: "203.0.113.8" as string | null,
  deferred: [] as Array<() => Promise<void>>,
}));
vi.mock("next/server", () => ({
  after: (task: () => Promise<void>) => mocks.deferred.push(task),
}));
vi.mock("@/modules", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: vi.fn(),
}));
vi.mock("@/lib/net/client-ip", () => ({ clientIpFrom: () => mocks.ip }));
vi.mock("@/lib/authz/subject", () => ({ getCurrentSubject: async () => GUEST_SUBJECT }));
vi.mock("@/lib/authz/require-admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/auth/ratelimit", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getPasswordChangeUser: async () => null,
  CLOSURE_ACCESS_COOKIE: "closure-access",
  clearClosureAccessCookie: vi.fn(),
  setClosureAccessCookie: vi.fn(),
  setSessionCookie: vi.fn(),
}));
vi.mock("@/lib/auth/account-deletion", () => ({
  AccountDeletionError: class AccountDeletionError extends Error {},
  cancelAccountDeletion: vi.fn(),
  consumeAccountDeletionEmailToken: vi.fn(),
  issueAccountDeletionAccessForEmail: vi.fn(),
  issueAccountDeletionRequestForEmail: vi.fn(),
  startOrOpenAccountDeletionWithPassword: vi.fn(),
}));
vi.mock("@/lib/mail", () => ({
  accountDeletionVerificationMail: vi.fn(),
  getMailBrand: vi.fn(),
  trySendMail: vi.fn(),
}));
vi.mock("@funwind/db", () => ({
  getWebDb: vi.fn(() => {
    throw new Error("动作单测禁止连接数据库");
  }),
}));

const brand = {
  siteName: "测试站",
  siteUrl: "https://example.test",
  tagline: "测试副标题",
  accent: "#123456",
};
const mail = {
  kind: "verify" as const,
  scene: "closure",
  subject: "验证",
  html: "内容",
  text: "内容",
};
const challenge = { email: "stored@example.com", token: "令牌 &/?=+" };
const entrances = [
  {
    kind: "access" as const,
    action: sendClosureAccessEmailAction,
    issue: vi.mocked(issueAccountDeletionAccessForEmail),
    other: vi.mocked(issueAccountDeletionRequestForEmail),
    key: "closure-access-email",
  },
  {
    kind: "request" as const,
    action: sendClosureRequestEmailAction,
    issue: vi.mocked(issueAccountDeletionRequestForEmail),
    other: vi.mocked(issueAccountDeletionAccessForEmail),
    key: "closure-request-email",
  },
];

function form(email = "  Mixed@Example.com  ") {
  const data = new FormData();
  data.set("email", email);
  return data;
}

async function neutralHop(result: Promise<void>) {
  await expect(result).rejects.toMatchObject({
    digest: "NEXT_REDIRECT;replace;/closure?sent=1;307;",
  });
  expect(getWebDb).not.toHaveBeenCalled();
  expect(requireAdmin).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deferred.length = 0;
  mocks.ip = "203.0.113.8";
  vi.mocked(rateLimit).mockReturnValue({ allowed: true, remaining: 1, retryAfterSec: 0 });
  vi.mocked(getMailBrand).mockResolvedValue(brand);
  vi.mocked(accountDeletionVerificationMail).mockReturnValue(mail);
  vi.mocked(trySendMail).mockResolvedValue(true);
  for (const entrance of entrances) entrance.issue.mockResolvedValue(challenge);
});

describe.each(entrances)("注销验证邮件：$kind", (entrance) => {
  it("先中性回跳，响应后才签发 challenge、取品牌、编码链接并发送对应用途邮件", async () => {
    await neutralHop(entrance.action(form()));
    expect(mocks.deferred).toHaveLength(1);
    expect(entrance.issue).not.toHaveBeenCalled();
    expect(trySendMail).not.toHaveBeenCalled();
    await mocks.deferred[0]!();
    expect(entrance.issue).toHaveBeenCalledExactlyOnceWith("Mixed@Example.com");
    expect(entrance.other).not.toHaveBeenCalled();
    expect(getMailBrand).toHaveBeenCalledExactlyOnceWith();
    expect(accountDeletionVerificationMail).toHaveBeenCalledExactlyOnceWith(
      `https://example.test/closure/verify?token=${encodeURIComponent(challenge.token)}`,
      entrance.kind,
      brand,
    );
    expect(trySendMail).toHaveBeenCalledExactlyOnceWith(challenge.email, mail);
    expect(entrance.issue).toHaveBeenCalledBefore(vi.mocked(getMailBrand));
    expect(getMailBrand).toHaveBeenCalledBefore(vi.mocked(accountDeletionVerificationMail));
    expect(accountDeletionVerificationMail).toHaveBeenCalledBefore(vi.mocked(trySendMail));
    expect(vi.mocked(rateLimit).mock.calls).toEqual([
      [`${entrance.key}:${hashEmailKey("mixed@example.com")}`, 3, 60 * 60_000],
      [`${entrance.key}-ip:203.0.113.8`, 10, 60 * 60_000],
    ]);
  });

  it("无 challenge 时不读取品牌、不构造或发送邮件，但对外回跳完全相同", async () => {
    entrance.issue.mockResolvedValue(null);
    await neutralHop(entrance.action(form()));
    expect(mocks.deferred).toHaveLength(1);
    expect(entrance.issue).not.toHaveBeenCalled();
    await mocks.deferred[0]!();
    expect(entrance.issue).toHaveBeenCalledExactlyOnceWith("Mixed@Example.com");
    expect(getMailBrand).not.toHaveBeenCalled();
    expect(accountDeletionVerificationMail).not.toHaveBeenCalled();
    expect(trySendMail).not.toHaveBeenCalled();
  });

  it("发送失败返回 false 时仍用相同中性提示，不透露账号或邮件发送状态", async () => {
    vi.mocked(trySendMail).mockResolvedValue(false);
    await neutralHop(entrance.action(form()));
    await expect(mocks.deferred[0]!()).resolves.toBeUndefined();
    expect(trySendMail).toHaveBeenCalledExactlyOnceWith(challenge.email, mail);
  });

  it("慢速签发与 SMTP 均不在中性响应之前执行，后台任务失败仅记录", async () => {
    let release: ((value: typeof challenge) => void) | undefined;
    entrance.issue.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await neutralHop(entrance.action(form()));
    expect(entrance.issue).not.toHaveBeenCalled();
    const task = mocks.deferred[0]!();
    expect(entrance.issue).toHaveBeenCalledOnce();
    expect(trySendMail).not.toHaveBeenCalled();
    release!(challenge);
    await task;
    expect(trySendMail).toHaveBeenCalledOnce();

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      entrance.issue.mockRejectedValueOnce(new Error("签发失败"));
      await neutralHop(entrance.action(form()));
      await expect(mocks.deferred[1]!()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        "[closure] 注销验证邮件后台任务失败:",
        { kind: entrance.kind },
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
    }
  });

  it.each([0, 1])("第 %s 个频控桶超限仍用相同中性提示且不签发 challenge", async (blocked) => {
    vi.mocked(rateLimit).mockImplementation((key) => ({
      allowed: blocked === 0 ? key.includes("-ip:") : !key.includes("-ip:"),
      remaining: 0,
      retryAfterSec: 3600,
    }));
    await neutralHop(entrance.action(form()));
    expect(rateLimit).toHaveBeenCalledTimes(blocked + 1);
    expect(entrance.issue).not.toHaveBeenCalled();
    expect(entrance.other).not.toHaveBeenCalled();
    expect(getMailBrand).not.toHaveBeenCalled();
    expect(trySendMail).not.toHaveBeenCalled();
  });

  it("没有可信 IP 只检查邮箱桶，不凭空生成 IP 配额键", async () => {
    mocks.ip = null;
    await neutralHop(entrance.action(form()));
    expect(vi.mocked(rateLimit).mock.calls).toEqual([
      [`${entrance.key}:${hashEmailKey("mixed@example.com")}`, 3, 60 * 60_000],
    ]);
  });

  it.each(["", "a", "a".repeat(255)])("非法邮箱输入 %s 在签发与频控前拒绝", async (email) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(entrance.action(form(email))).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
      expect(rateLimit).not.toHaveBeenCalled();
      expect(entrance.issue).not.toHaveBeenCalled();
      expect(trySendMail).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

it("同一邮箱在两类邮件入口使用独立的邮箱与 IP 配额桶", async () => {
  await neutralHop(sendClosureAccessEmailAction(form()));
  await neutralHop(sendClosureRequestEmailAction(form()));
  const hash = hashEmailKey("mixed@example.com");
  expect(vi.mocked(rateLimit).mock.calls).toEqual([
    [`closure-access-email:${hash}`, 3, 60 * 60_000],
    ["closure-access-email-ip:203.0.113.8", 10, 60 * 60_000],
    [`closure-request-email:${hash}`, 3, 60 * 60_000],
    ["closure-request-email-ip:203.0.113.8", 10, 60 * 60_000],
  ]);
});
