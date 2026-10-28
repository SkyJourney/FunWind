// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getForumView } from "@/lib/queries/forums";
import { getHomeFeed, listThreads } from "@/lib/queries/threads";
import { tagByName } from "@/lib/interact/tags";
import { GET as homeGET } from "./home/route";
import { GET as forumGET } from "./forum/[fid]/route";

vi.mock("@/lib/authz/subject", () => ({ getCurrentSubject: vi.fn() }));
vi.mock("@/lib/authz/snapshot", () => ({
  getForumTree: vi.fn(async () => ({
    get: (id: number) => (id === 7 ? { name: "测试板块" } : undefined),
  })),
}));
vi.mock("@/lib/queries/threads", () => ({ getHomeFeed: vi.fn(), listThreads: vi.fn() }));
vi.mock("@/lib/queries/forums", () => ({ getForumView: vi.fn() }));
vi.mock("@/lib/interact/tags", () => ({ tagByName: vi.fn(async () => null) }));

const guest = {
  userId: null,
  roles: [],
  restrictions: [],
  emailVerified: false,
  registerMode: "invite" as const,
};
const home = (qs = "") => new Request(`http://127.0.0.1:3100/api/stream/home${qs}`);
const forum = (fid: string, qs = "") =>
  forumGET(new Request(`http://127.0.0.1:3100/api/stream/forum/${fid}${qs}`), {
    params: Promise.resolve({ fid }),
  });
const thread = (id: number, forumId = 7) => ({ id, forumId, title: `t${id}` }) as never;

beforeEach(() => {
  resetRateLimiter();
  vi.clearAllMocks();
  vi.mocked(getCurrentSubject).mockResolvedValue(guest);
});

describe("GET /api/stream/home", () => {
  it("透传 sec/sort/page 给 getHomeFeed，并补板块名；响应不进共享缓存", async () => {
    vi.mocked(getHomeFeed).mockResolvedValue({
      items: [thread(1), thread(2, 999)] as never,
      hasMore: true,
      page: 3,
    });
    const res = await homeGET(home("?sec=5&sort=new&page=3"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(getHomeFeed).toHaveBeenCalledWith(guest, { sectionId: 5, sort: "new", page: 3 });
    const body = await res.json();
    expect(body.hasMore).toBe(true);
    expect(body.page).toBe(3);
    expect(body.items.map((i: { forumName: string | null }) => i.forumName)).toEqual([
      "测试板块",
      null,
    ]);
  });

  it("非法参数收束：sort 回落 last、sec 非法忽略、page 异常回第 1 页", async () => {
    vi.mocked(getHomeFeed).mockResolvedValue({ items: [], hasMore: false, page: 1 });
    await homeGET(home("?sec=-1&sort=hack&page=abc"));
    expect(getHomeFeed).toHaveBeenCalledWith(guest, {
      sectionId: undefined,
      sort: "last",
      page: 1,
    });
  });

  it("按 IP 限流：第 121 次 429，被拒请求不进入查询", async () => {
    vi.mocked(getHomeFeed).mockResolvedValue({ items: [], hasMore: false, page: 1 });
    for (let i = 0; i < 120; i++) expect((await homeGET(home())).status).toBe(200);
    expect((await homeGET(home())).status).toBe(429);
    expect(getHomeFeed).toHaveBeenCalledTimes(120);
  });
});

describe("GET /api/stream/forum/[fid]", () => {
  it("读不到 / 不存在 / 分区 → 404，且不会去查主题列表", async () => {
    vi.mocked(getForumView).mockResolvedValueOnce(null);
    expect((await forum("121")).status).toBe(404);
    vi.mocked(getForumView).mockResolvedValueOnce({ kind: "section" } as never);
    expect((await forum("3")).status).toBe(404);
    expect((await forum("abc")).status).toBe(404);
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("有下一页：hasMore=true，参数透传（前缀 / 页码）", async () => {
    vi.mocked(getForumView).mockResolvedValue({ kind: "forum" } as never);
    vi.mocked(listThreads).mockResolvedValue({
      pinned: [],
      items: [thread(10), thread(11)],
      total: 60,
      page: 2,
      totalPages: 3,
    });
    const res = await forum("7", "?type=4&page=2");
    expect(listThreads).toHaveBeenCalledWith(guest, 7, { page: 2, prefixId: 4, tagId: undefined });
    expect(await res.json()).toMatchObject({ hasMore: true, page: 2 });
  });

  it("末页：hasMore=false；页码越界（被收束到末页）返回空页，避免重复追加", async () => {
    vi.mocked(getForumView).mockResolvedValue({ kind: "forum" } as never);
    vi.mocked(listThreads).mockResolvedValue({
      pinned: [],
      items: [thread(30)],
      total: 26,
      page: 2,
      totalPages: 2,
    });
    expect(await (await forum("7", "?page=2")).json()).toMatchObject({ hasMore: false, page: 2 });
    const over = await (await forum("7", "?page=9")).json();
    expect(over).toEqual({ items: [], hasMore: false, page: 9 });
  });

  it("未知标签按无筛选处理（与板块页一致），已知标签透传 tagId", async () => {
    vi.mocked(getForumView).mockResolvedValue({ kind: "forum" } as never);
    vi.mocked(listThreads).mockResolvedValue({
      pinned: [],
      items: [],
      total: 0,
      page: 1,
      totalPages: 1,
    });
    await forum("7", "?tag=nope");
    expect(listThreads).toHaveBeenLastCalledWith(
      guest,
      7,
      expect.objectContaining({ tagId: undefined }),
    );
    vi.mocked(tagByName).mockResolvedValueOnce({ id: 42, name: "x" } as never);
    await forum("7", "?tag=x");
    expect(listThreads).toHaveBeenLastCalledWith(guest, 7, expect.objectContaining({ tagId: 42 }));
  });
});
