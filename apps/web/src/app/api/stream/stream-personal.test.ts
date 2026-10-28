// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { getCurrentUser } from "@/lib/auth/session";
import { listFeed } from "@/lib/notifications/queries";
import { conversationPage } from "@/lib/pm/queries";
import { getLedgerPage } from "@/lib/points/ledger";
import { GET as conversationsGET } from "./conversations/route";
import { GET as notificationsGET } from "./notifications/route";
import { GET as pointsGET } from "./points/route";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/notifications/queries", () => ({ listFeed: vi.fn() }));
vi.mock("@/lib/pm/queries", () => ({ conversationPage: vi.fn() }));
vi.mock("@/lib/points/ledger", () => ({ getLedgerPage: vi.fn() }));

const get = (path: string, qs = "") => new Request(`http://127.0.0.1:3100/api/stream/${path}${qs}`);

beforeEach(() => {
  resetRateLimiter();
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: 5 } as never);
});

describe("个人数据端点：游客一律 401，且不触碰查询", () => {
  it.each([
    ["points", pointsGET, getLedgerPage],
    ["conversations", conversationsGET, conversationPage],
    ["notifications", notificationsGET, listFeed],
  ] as const)("%s", async (name, handler, query) => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await handler(get(name));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("GET /api/stream/points", () => {
  it("只读自己的台账（userId 取自会话）；hasMore 取决于是否末页", async () => {
    vi.mocked(getLedgerPage).mockResolvedValue({
      items: [{ id: 1 }],
      page: 2,
      totalPages: 3,
    } as never);
    const res = await pointsGET(get("points", "?page=2&userId=999"));
    expect(getLedgerPage).toHaveBeenCalledWith(5, 2);
    expect(await res.json()).toMatchObject({ hasMore: true, page: 2 });
  });

  it("页码越界返回空页，避免重复追加末页", async () => {
    vi.mocked(getLedgerPage).mockResolvedValue({
      items: [{ id: 1 }],
      page: 2,
      totalPages: 2,
    } as never);
    expect(await (await pointsGET(get("points", "?page=9"))).json()).toEqual({
      items: [],
      hasMore: false,
      page: 9,
    });
  });
});

describe("GET /api/stream/conversations", () => {
  it("以会话 id 作流的 id；只查自己（忽略任何 userId 参数）", async () => {
    vi.mocked(conversationPage).mockResolvedValue({
      items: [{ conversationId: 12, otherName: "a" }],
      hasMore: true,
      page: 2,
    } as never);
    const body = await (await conversationsGET(get("conversations", "?page=2&userId=999"))).json();
    expect(conversationPage).toHaveBeenCalledWith(5, 2);
    expect(body.items[0]).toMatchObject({ id: 12, conversationId: 12 });
    expect(body).toMatchObject({ hasMore: true, page: 2 });
  });
});

describe("GET /api/stream/notifications", () => {
  const feedItem = {
    kind: "notification",
    id: 9,
    category: "interaction",
    type: "post.replied",
    actorId: 1,
    actorName: "x",
    read: false,
    createdAt: "2026-10-28 10:00:00",
    data: { secret: "不应下发" },
  };

  it("游标分页：透传 cat/before，返回 nextCursor；行数据已预渲染且不含原始载荷", async () => {
    vi.mocked(listFeed).mockResolvedValue({
      items: [feedItem],
      nextCursor: "2026-10-28 09:00:00",
    } as never);
    const res = await notificationsGET(
      get("notifications", "?cat=interaction&before=2026-10-28%2010%3A00%3A00"),
    );
    expect(listFeed).toHaveBeenCalledWith(5, {
      category: "interaction",
      before: "2026-10-28 10:00:00",
    });
    const body = await res.json();
    expect(body).toMatchObject({ hasMore: true, nextCursor: "2026-10-28 09:00:00", page: 0 });
    expect(body.items[0]).toMatchObject({ key: "notification:9", read: false });
    expect(JSON.stringify(body)).not.toContain("不应下发");
  });

  it("最后一段：nextCursor 为 null → hasMore=false；非法分类忽略", async () => {
    vi.mocked(listFeed).mockResolvedValue({ items: [feedItem], nextCursor: null } as never);
    const body = await (await notificationsGET(get("notifications", "?cat=hack"))).json();
    expect(listFeed).toHaveBeenCalledWith(5, { category: undefined, before: undefined });
    expect(body).toMatchObject({ hasMore: false, nextCursor: null });
  });
});
