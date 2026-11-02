// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentUser } from "@/lib/auth/session";
import { listFeed, unreadSummary } from "@/lib/notifications/queries";
import { GET } from "./route";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/notifications/queries", () => ({ listFeed: vi.fn(), unreadSummary: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(null);
  vi.mocked(unreadSummary).mockResolvedValue({
    total: 0,
    interaction: 0,
    message: 0,
    moderation: 0,
    account: 0,
    announcement: 0,
  });
  vi.mocked(listFeed).mockResolvedValue({ items: [], nextCursor: null });
});

describe("铃铛读取边界", () => {
  it("游客查询保持公告读取语义，但不允许 HTTP 缓存", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(unreadSummary).toHaveBeenCalledExactlyOnceWith(null);
    expect(listFeed).toHaveBeenCalledExactlyOnceWith(null, { limit: 10, onlyUnread: true });
    expect(await response.json()).toMatchObject({ unread: { total: 0 }, recent: [] });
  });
  it("只查询当前会话身份，不把会话响应公开缓存或授予跨源读取", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 42,
      username: "test-user",
      email: null,
      emailVerified: true,
      passwordHashIsSet: true,
    });
    const response = await GET();
    expect(unreadSummary).toHaveBeenCalledExactlyOnceWith(42);
    expect(listFeed).toHaveBeenCalledExactlyOnceWith(42, { limit: 10, onlyUnread: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });
});
