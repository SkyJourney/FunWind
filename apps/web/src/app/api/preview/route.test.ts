// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimit, resetRateLimiter } from "@/lib/auth/ratelimit";
import { getCurrentUser } from "@/lib/auth/session";
import { markdownCacheSize, renderMarkdown } from "@/lib/markdown";
import { POST } from "./route";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));

const url = "http://127.0.0.1:3100/api/preview";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const asUser = (id: number) =>
  vi.mocked(getCurrentUser).mockResolvedValue({
    id,
    username: `u${id}`,
    email: null,
    emailVerified: false,
    passwordHashIsSet: false,
  });

beforeEach(() => {
  resetRateLimiter();
  vi.mocked(getCurrentUser).mockResolvedValue(null);
});

describe("POST /api/preview", () => {
  it("登录用户、同源请求：返回净化后的 HTML", async () => {
    asUser(1);
    const res = await POST(post({ source: "**粗体**" }, { origin: "http://127.0.0.1:3100" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { html: string }).toMatchObject({
      html: expect.stringContaining("<strong>粗体</strong>"),
    });
  });

  it("游客：401，不渲染", async () => {
    const res = await POST(post({ source: "**粗体**" }));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("<strong>");
  });

  it("跨站 Origin：403，不渲染（先于登录判断）", async () => {
    asUser(1);
    const res = await POST(post({ source: "x" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("非 JSON 或缺字段：400", async () => {
    asUser(1);
    expect((await POST(post("not json"))).status).toBe(400);
    expect((await POST(post({ notSource: 1 }))).status).toBe(400);
  });

  it("请求体超过字节上限（分块、无 Content-Length）：413，且不渲染", async () => {
    asUser(1);
    const huge = JSON.stringify({ source: "x".repeat(950_000) });
    // 用流式 body 发送，不带 Content-Length，模拟分块传输
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });
    const req = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await POST(req)).status).toBe(413);
  });

  it("声明的 Content-Length 超限：直接 413", async () => {
    asUser(1);
    const res = await POST(post({ source: "x" }, { "content-length": "2000000" }));
    expect(res.status).toBe(413);
  });

  it("门控正文不出现在响应中（泄露回归）", async () => {
    asUser(1);
    const res = await POST(
      post({ source: ':::gate{key="g1" unlock="points" price="10"}\nSECRET-ROUTE 隐藏\n:::' }),
    );
    expect(await res.text()).not.toContain("SECRET-ROUTE");
  });

  it("每用户桶：同一用户超过 60 次 / 分钟即 429，另一用户不受影响", async () => {
    asUser(1);
    for (let i = 0; i < 60; i++) {
      expect((await POST(post({ source: "x" }))).status).toBe(200);
    }
    expect((await POST(post({ source: "x" }))).status).toBe(429);
    asUser(2);
    expect((await POST(post({ source: "x" }))).status).toBe(200);
  });

  it("用户超限的请求不占全局额度：61 次里只有 60 次消耗全局桶", async () => {
    asUser(1);
    for (let i = 0; i < 61; i++) await POST(post({ source: "x" }));
    // 探针：全局桶已占用的次数 = 600 - remaining - 1（探针本身占用一次）
    const probe = rateLimit("preview:global", 600, 60_000);
    expect(probe.remaining).toBe(600 - 60 - 1);
  });

  it("预览不污染共享渲染缓存：大量不同输入之后，缓存条目数不变", async () => {
    asUser(1);
    renderMarkdown("真实帖子的内容 A");
    renderMarkdown("真实帖子的内容 B");
    const before = markdownCacheSize();
    for (let i = 0; i < 5; i++) {
      expect((await POST(post({ source: `预览输入 ${i}` }))).status).toBe(200);
    }
    expect(markdownCacheSize()).toBe(before);
  });
});
