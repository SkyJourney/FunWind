import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsHubPage from "./page";
import NotificationsPage from "../notifications/page";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
  summary: vi.fn(),
  feed: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@funwind/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@funwind/db")>()),
  getWebDb: () => ({ select: mocks.select }),
}));
vi.mock("@/lib/notifications/queries", () => ({
  unreadSummary: mocks.summary,
  listFeed: mocks.feed,
}));
vi.mock("@/app/actions/notifications", () => ({ markAllReadAction: vi.fn() }));
vi.mock("@/lib/notifications/row", () => ({ toNotificationRow: vi.fn() }));
vi.mock("@/components/notifications/notification-row", () => ({ NotificationRow: () => null }));
vi.mock("@/components/notifications/notification-stream", () => ({
  NotificationStream: ({ children }: { children: ReactNode }) => children,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: 42 });
  mocks.select.mockReturnValue({ from: mocks.from });
  mocks.from.mockReturnValue({ where: mocks.where });
  mocks.where.mockReturnValue({ limit: mocks.limit });
  mocks.limit.mockResolvedValue([
    { username: "u42", email: null, emailVerifiedAt: null, legacyPending: false },
  ]);
  mocks.summary.mockResolvedValue({
    total: 0,
    interaction: 0,
    message: 0,
    moderation: 0,
    account: 0,
    announcement: 0,
  });
  mocks.feed.mockResolvedValue({ items: [], nextCursor: null });
});

describe("偏好设置入口小项", () => {
  it("设置 hub 补齐外观、头像、私信偏好，保留既有设置卡片", async () => {
    render(await SettingsHubPage());
    for (const [title, href] of [
      ["外观", "/settings/appearance"],
      ["头像", "/settings/avatar"],
      ["私信偏好", "/settings/pm"],
      ["账号安全", "/settings/password"],
      ["邮箱", "/settings/email"],
      ["个人资料", "/settings/profile"],
      ["通知偏好", "/settings/notifications"],
      ["注销账号", "/settings/delete-account"],
    ]) {
      expect(screen.getByRole("link", { name: new RegExp(`^${title}`) })).toHaveAttribute(
        "href",
        href,
      );
    }
    expect(screen.getAllByRole("link")).toHaveLength(8);
  });

  it.each([{}, { cat: "message" }])("通知页提供现有偏好链接，分类查询不变：%j", async (search) => {
    render(await NotificationsPage({ searchParams: Promise.resolve(search) }));
    expect(screen.getByRole("link", { name: "通知偏好" })).toHaveAttribute(
      "href",
      "/settings/notifications",
    );
    expect(screen.getByRole("navigation", { name: "通知分类" })).toBeInTheDocument();
    expect(mocks.feed).toHaveBeenCalledExactlyOnceWith(42, {
      category: "cat" in search ? search.cat : undefined,
      before: undefined,
    });
    expect(screen.getByText("这里很安静")).toBeInTheDocument();
  });
});
