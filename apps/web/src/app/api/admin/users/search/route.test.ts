import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * 管理端用户搜索端点（M19 D4）：门口链顺序与 JSON 语义——
 * 跨源 403；未登录/无权限 404（不暴露端点存在性）；登录管理员返回「用户名 (uid)」候选。
 */
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  searchUsers: vi.fn(),
}));
vi.mock("@/lib/authz/require-admin", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/authz/admin-user-views", () => ({ searchUsers: mocks.searchUsers }));
vi.mock("@funwind/db", () => ({ getWebDb: vi.fn() }));
vi.mock("@/modules", () => ({}));

import { GET } from "./route";

const url = (origin?: string) =>
  new Request("http://127.0.0.1:3100/api/admin/users/search?q=demo", {
    headers: origin ? { origin } : {},
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ userId: 90004, ip: null });
  mocks.searchUsers.mockResolvedValue([
    { id: 90004, username: "demo_admin", createdAt: "", threadCount: 0, postCount: 0 },
  ]);
});

describe("GET /api/admin/users/search", () => {
  it("同源管理员：返回前 10 条 label 候选，private no-store", async () => {
    const res = await GET(url("http://127.0.0.1:3100"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const data = await res.json();
    expect(data.items).toEqual([
      { id: 90004, username: "demo_admin", label: "demo_admin (uid 90004)" },
    ]);
    expect(mocks.searchUsers).toHaveBeenCalledWith("demo");
  });

  it("跨源 403；requireAdmin 抛 notFound（非管理员）原样向上冒泡为 404 语义", async () => {
    const cross = await GET(url("https://evil.example"));
    expect(cross.status).toBe(403);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();

    mocks.requireAdmin.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;404"));
    await expect(GET(url("http://127.0.0.1:3100"))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("无 Origin（非浏览器客户端）放行走既有鉴权", async () => {
    const res = await GET(url());
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
  });
});
