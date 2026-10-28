// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { getCurrentUser } from "@/lib/auth/session";
import { isConversationMember, messagesBefore } from "@/lib/pm/queries";
import { GET } from "./messages/[convId]/route";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/pm/queries", () => ({ isConversationMember: vi.fn(), messagesBefore: vi.fn() }));

const get = (convId: string, qs = "") =>
  GET(new Request(`http://127.0.0.1:3100/api/stream/messages/${convId}${qs}`), {
    params: Promise.resolve({ convId }),
  });
const msg = (id: number) => ({ id, senderId: 1, body: `m${id}`, createdAt: "2026-10-28 10:00:00" });

beforeEach(() => {
  resetRateLimiter();
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: 5 } as never);
  vi.mocked(isConversationMember).mockResolvedValue(true);
});

describe("GET /api/stream/messages/[convId]", () => {
  it("游客 401，且不查成员也不查消息", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    expect((await get("12")).status).toBe(401);
    expect(isConversationMember).not.toHaveBeenCalled();
    expect(messagesBefore).not.toHaveBeenCalled();
  });

  it("非成员与非法会话 id → 404（同一表现，不暴露会话是否存在），且不查消息", async () => {
    vi.mocked(isConversationMember).mockResolvedValueOnce(false);
    expect((await get("12")).status).toBe(404);
    expect((await get("abc")).status).toBe(404);
    expect(messagesBefore).not.toHaveBeenCalled();
  });

  it("成员：透传 before 游标；nextCursor 是本批最旧一条的 id", async () => {
    vi.mocked(messagesBefore).mockResolvedValue({ items: [msg(41), msg(42)], hasMore: true });
    const res = await get("12", "?before=50");
    expect(isConversationMember).toHaveBeenCalledWith(5, 12);
    expect(messagesBefore).toHaveBeenCalledWith(12, 50);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toMatchObject({ hasMore: true, nextCursor: "41", page: 0 });
  });

  it("最后一批：nextCursor 为 null；缺省/非法 before 取最新一批", async () => {
    vi.mocked(messagesBefore).mockResolvedValue({ items: [msg(1)], hasMore: false });
    expect(await (await get("12", "?before=abc")).json()).toMatchObject({
      hasMore: false,
      nextCursor: null,
    });
    expect(messagesBefore).toHaveBeenCalledWith(12, null);
  });

  it("按 IP 限流：第 121 次 429", async () => {
    vi.mocked(messagesBefore).mockResolvedValue({ items: [], hasMore: false });
    for (let i = 0; i < 120; i++) expect((await get("12")).status).toBe(200);
    expect((await get("12")).status).toBe(429);
  });
});
