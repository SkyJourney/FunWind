// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  subject: vi.fn(),
  check: vi.fn(),
  moderated: vi.fn(),
  headers: vi.fn(),
  ip: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("./subject", () => ({ loadSubject: mocks.subject }));
vi.mock("./service", () => ({
  checkPermission: mocks.check,
  getModeratedForumIds: mocks.moderated,
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/net/client-ip", () => ({ clientIpFrom: mocks.ip }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
import { requireModerator } from "./require-admin";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: 123 });
  mocks.subject.mockResolvedValue({ userId: 123 });
  mocks.check.mockResolvedValue({ allowed: false });
  mocks.moderated.mockResolvedValue([]);
  mocks.headers.mockResolvedValue(new Headers());
  mocks.ip.mockReturnValue(null);
});

describe("后台总门：site.admin 或任一板块版主", () => {
  it("未登录先跳登录页，不取授权数据", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(requireModerator()).rejects.toThrow("REDIRECT:/login");
    expect(mocks.subject).not.toHaveBeenCalled();
  });

  it("普通会员没有站长权限也无管理板块，返回 404", async () => {
    await expect(requireModerator()).rejects.toThrow("NOT_FOUND");
    expect(mocks.headers).not.toHaveBeenCalled();
  });

  it("版主可达，返回审计身份", async () => {
    mocks.moderated.mockResolvedValue([904]);
    await expect(requireModerator()).resolves.toEqual({ userId: 123, ip: null });
  });

  it("空站点没有任何板块时，站长仍可达", async () => {
    mocks.check.mockResolvedValue({ allowed: true });
    await expect(requireModerator()).resolves.toEqual({ userId: 123, ip: null });
    expect(mocks.check).toHaveBeenCalledWith({ userId: 123 }, "site.admin");
  });
});
