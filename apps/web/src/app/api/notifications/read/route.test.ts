// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentUser } from "@/lib/auth/session";
import { markRead } from "@/lib/notifications/queries";
import { POST } from "./route";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/notifications/queries", () => ({ markRead: vi.fn() }));

const request = (body: unknown, origin = "http://127.0.0.1:3100") =>
  new Request("http://localhost:3100/api/notifications/read", {
    method: "POST",
    headers: { host: "127.0.0.1:3100", origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue({
    id: 42,
    username: "test-user",
    email: null,
    emailVerified: true,
    passwordHashIsSet: true,
  });
  vi.mocked(markRead).mockResolvedValue(undefined);
});

describe("通知已读写入边界", () => {
  it("跨源写入在鉴权与取数前拒绝", async () => {
    expect((await POST(request({ all: true }, "https://example.com"))).status).toBe(403);
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
  });
  it("未登录返回 401、不写库", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    expect((await POST(request({ all: true }))).status).toBe(401);
    expect(markRead).not.toHaveBeenCalled();
  });
  it.each([{}, { ids: [0] }, { category: "unknown" }])("非法输入 %j 不写库", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(markRead).not.toHaveBeenCalled();
  });
  it("同源有效输入只更新当前用户", async () => {
    expect((await POST(request({ all: true }))).status).toBe(204);
    expect(markRead).toHaveBeenCalledExactlyOnceWith(42, {
      ids: undefined,
      category: undefined,
      all: true,
    });
  });
});
