// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { GUEST_SUBJECT } from "@/lib/authz/types";
import { getCurrentSubject } from "@/lib/authz/subject";
import { rateLimit } from "@/lib/auth/ratelimit";
import { toggleLike } from "@/lib/interact/reactions";
import { toggleFollow } from "@/lib/interact/follows";
import { followAction, likeAction } from "./interact";

vi.mock("@/modules", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/net/client-ip", () => ({ clientIpFrom: () => null }));
vi.mock("@/lib/authz/subject", () => ({ getCurrentSubject: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getPasswordChangeUser: async () => null }));
vi.mock("@/lib/authz/require-admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/auth/ratelimit", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/interact/reactions", () => ({ toggleLike: vi.fn() }));
vi.mock("@/lib/interact/follows", () => ({ toggleFollow: vi.fn() }));

const cases = [
  { name: "点赞", action: likeAction, fields: { postId: "123" } },
  {
    name: "关注",
    action: followAction,
    fields: { targetType: "user", targetId: "42" },
  },
];

function form(fields: Record<string, string | undefined>, back?: string | Blob) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data.set(key, value);
  }
  if (back !== undefined) data.set("back", back);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentSubject).mockResolvedValue({ ...GUEST_SUBJECT, userId: 7 });
  vi.mocked(rateLimit).mockReturnValue({ allowed: false, remaining: 0, retryAfterSec: 60 });
  vi.mocked(toggleLike).mockResolvedValue({ ok: true, liked: true, likeCount: 1 });
  vi.mocked(toggleFollow).mockResolvedValue({ ok: true, following: true });
});

describe.each(cases)("互动频控回跳：$name", ({ action, fields }) => {
  it("通过真实动作骨架将解析后的 back 交给 onLimit，保留页码、筛选与锚点", async () => {
    await expect(
      action(form(fields, "/t/123?page=2&tag=demo&notice=old#p456")),
    ).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/t/123?page=2&tag=demo&notice=interact-rate#p456;307;",
    });
    expect(rateLimit).toHaveBeenCalledWith("interact:7", 30, 60_000);
    expect(toggleLike).not.toHaveBeenCalled();
    expect(toggleFollow).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "",
    "https://example.com/t/123",
    "//example.com/t/123",
    "/\\example.com/t/123",
    "/\n/example.com/t/123",
    "/./..//example.com/t/123",
    "/%2e%2e//example.com/t/123",
  ])("不安全或缺失 back %s 回首页并携带可消费提示", async (back) => {
    await expect(action(form(fields, back))).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/?notice=interact-rate;307;",
    });
    expect(toggleLike).not.toHaveBeenCalled();
    expect(toggleFollow).not.toHaveBeenCalled();
  });

  it("文件类型 back 回退而非让频控提示失效", async () => {
    await expect(action(form(fields, new Blob(["back"])))).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/?notice=interact-rate;307;",
    });
  });

  it("未超限仍原地更新，revalidate 只接收 pathname", async () => {
    vi.mocked(rateLimit).mockReturnValue({ allowed: true, remaining: 29, retryAfterSec: 0 });
    await expect(action(form(fields, "/t/123?page=2#p456"))).resolves.toBeUndefined();
    expect(revalidatePath).toHaveBeenCalledWith("/t/123");
    if (action === likeAction) expect(toggleLike).toHaveBeenCalledWith(7, 123);
    else expect(toggleFollow).toHaveBeenCalledWith(7, "user", 42);
  });
});
