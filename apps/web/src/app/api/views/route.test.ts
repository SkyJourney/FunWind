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

  it("拿不到可信 IP：换 User-Agent 不能绕过限额（共用 unknown 桶，第 121 次 429）", async () => {
    const { recordThreadView } = await import("@/lib/views/record");
    for (let i = 0; i < 120; i++) {
      expect((await POST(post({ tid: 900101 }, { "user-agent": `ua-${i}` }))).status).toBe(204);
    }
    expect((await POST(post({ tid: 900101 }, { "user-agent": "fresh" }))).status).toBe(429);
    // 被拒的请求不会进入记录逻辑
    expect(vi.mocked(recordThreadView)).toHaveBeenCalledTimes(120);
    expect(vi.mocked(recordThreadView).mock.calls[0]![0]).toMatchObject({ ip: null });
  });

  it("登录用户按账号限额：换 IP（XFF）也不能无限刷，第 121 次 429", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    try {
      vi.mocked(getCurrentSubject).mockResolvedValue({
        userId: 5,
        roles: [{ key: "member", scopeId: 0 }],
        restrictions: [],
        emailVerified: true,
        registerMode: "invite",
      });
      for (let i = 0; i < 120; i++) {
        expect(
          (await POST(post({ tid: 900101 }, { "x-forwarded-for": `198.51.100.${i % 250}` })))
            .status,
        ).toBe(204);
      }
      expect(
        (await POST(post({ tid: 900101 }, { "x-forwarded-for": "203.0.113.99" }))).status,
      ).toBe(429);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
