// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { getCurrentUser } from "@/lib/auth/session";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getFollowFeed } from "@/lib/queries/follows-feed";
import { getProfile, getUserReplies, getUserThreads } from "@/lib/queries/users";
import { GET as followsGET } from "./follows/route";
import { GET as userGET } from "./user/[uid]/route";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/authz/subject", () => ({ getCurrentSubject: vi.fn() }));
vi.mock("@/lib/authz/snapshot", () => ({
  getForumTree: vi.fn(async () => ({
    get: (id: number) => (id === 7 ? { name: "测试板块" } : undefined),
  })),
}));
vi.mock("@/lib/queries/users", () => ({
  getProfile: vi.fn(),
  getUserThreads: vi.fn(),
  getUserReplies: vi.fn(),
}));
vi.mock("@/lib/queries/follows-feed", () => ({ getFollowFeed: vi.fn() }));

const subject = {
  userId: 5,
  roles: [],
  restrictions: [],
  emailVerified: true,
  emailVerificationRequired: false,
  registerMode: "invite" as const,
};
const user = (uid: string, qs = "") =>
  userGET(new Request(`http://127.0.0.1:3100/api/stream/user/${uid}${qs}`), {
    params: Promise.resolve({ uid }),
  });
const follows = (qs = "") =>
  followsGET(new Request(`http://127.0.0.1:3100/api/stream/follows${qs}`));
const paged = <T>(items: T[], page: number, totalPages: number) => ({
  items,
  total: 99,
  page,
  totalPages,
});

beforeEach(() => {
  resetRateLimiter();
  vi.clearAllMocks();
  vi.mocked(getCurrentSubject).mockResolvedValue(subject);
  vi.mocked(getProfile).mockResolvedValue({ id: 9 } as never);
});

describe("GET /api/stream/user/[uid]", () => {
  it("用户不存在 / 已注销 / uid 非法 → 404，且不查内容", async () => {
    vi.mocked(getProfile).mockResolvedValueOnce(null);
    expect((await user("9")).status).toBe(404);
    expect((await user("abc")).status).toBe(404);
    expect(getUserThreads).not.toHaveBeenCalled();
    expect(getUserReplies).not.toHaveBeenCalled();
  });

  it("主题 tab（缺省）：透传页码，hasMore 取决于是否末页", async () => {
    vi.mocked(getUserThreads).mockResolvedValue(paged([{ id: 1 }], 2, 3) as never);
    const res = await user("9", "?page=2");
    expect(getUserThreads).toHaveBeenCalledWith(subject, 9, 2);
    expect(await res.json()).toMatchObject({ hasMore: true, page: 2 });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("回复 tab：以 postId 作为流的 id；越界页返回空页", async () => {
    vi.mocked(getUserReplies).mockResolvedValue(
      paged([{ postId: 77, threadId: 1, threadTitle: "t", floor: 2 }], 3, 3) as never,
    );
    const body = await (await user("9", "?tab=replies&page=3")).json();
    expect(body.items[0]).toMatchObject({ id: 77, postId: 77 });
    expect(body.hasMore).toBe(false);

    const over = await (await user("9", "?tab=replies&page=9")).json();
    expect(over).toEqual({ items: [], hasMore: false, page: 9 });
  });

  it("按 IP 限流：第 121 次 429", async () => {
    vi.mocked(getUserThreads).mockResolvedValue(paged([], 1, 1) as never);
    for (let i = 0; i < 120; i++) expect((await user("9")).status).toBe(200);
    expect((await user("9")).status).toBe(429);
  });
});

describe("GET /api/stream/follows", () => {
  it("游客 401，且不触碰查询", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await follows();
    expect(res.status).toBe(401);
    expect(getFollowFeed).not.toHaveBeenCalled();
  });

  it("登录用户：透传 type/page，补板块名；非法 type 回落 all", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 5 } as never);
    vi.mocked(getFollowFeed).mockResolvedValue({
      ...paged(
        [
          { id: 1, forumId: 7 },
          { id: 2, forumId: 999 },
        ],
        2,
        4,
      ),
      forumCount: 1,
      userCount: 0,
    } as never);
    const body = await (await follows("?type=forum&page=2")).json();
    expect(getFollowFeed).toHaveBeenCalledWith(subject, 2, "forum");
    expect(body.items.map((i: { forumName: string | null }) => i.forumName)).toEqual([
      "测试板块",
      null,
    ]);
    expect(body).toMatchObject({ hasMore: true, page: 2 });

    await follows("?type=hack");
    expect(getFollowFeed).toHaveBeenLastCalledWith(subject, 1, "all");
  });

  it("页码越界返回空页，避免重复追加末页", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 5 } as never);
    vi.mocked(getFollowFeed).mockResolvedValue({
      ...paged([{ id: 1, forumId: 7 }], 2, 2),
      forumCount: 1,
      userCount: 0,
    } as never);
    expect(await (await follows("?page=9")).json()).toEqual({ items: [], hasMore: false, page: 9 });
  });
});
