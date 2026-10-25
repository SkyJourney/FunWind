// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { getCurrentSubject } from "@/lib/authz/subject";
import { POST } from "./route";

vi.mock("@/lib/authz/subject", () => ({ getCurrentSubject: vi.fn() }));
vi.mock("@/lib/views/record", () => ({ recordThreadView: vi.fn(async () => "counted") }));

const url = "http://127.0.0.1:3100/api/views";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3100", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  resetRateLimiter();
  vi.mocked(getCurrentSubject).mockResolvedValue({
    userId: null,
    roles: [],
    restrictions: [],
    emailVerified: false,
    registerMode: "invite",
  });
});

describe("POST /api/views", () => {
  it("正常阅读：204，无响应体（不泄露主题是否存在或是否计入）", async () => {
    const res = await POST(post({ tid: 900101 }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("跨站 Origin：403", async () => {
    expect((await POST(post({ tid: 1 }, { origin: "https://evil.example" }))).status).toBe(403);
  });

  it("格式错误：400", async () => {
    expect((await POST(post("not json"))).status).toBe(400);
    expect((await POST(post({ tid: -1 }))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
  });
});
