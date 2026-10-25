// @vitest-environment node
import { describe, expect, it } from "vitest";
import { POST } from "./route";

const url = "http://127.0.0.1:3100/api/preview";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/preview", () => {
  it("同源请求：返回净化后的 HTML", async () => {
    const res = await POST(post({ source: "**粗体**" }, { origin: "http://127.0.0.1:3100" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { html: string }).toMatchObject({
      html: expect.stringContaining("<strong>粗体</strong>"),
    });
  });

  it("跨站 Origin：403，不渲染", async () => {
    const res = await POST(post({ source: "x" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("非 JSON 或缺字段：400", async () => {
    expect((await POST(post("not json"))).status).toBe(400);
    expect((await POST(post({ notSource: 1 }))).status).toBe(400);
  });

  it("门控正文不出现在响应中（泄露回归）", async () => {
    const res = await POST(
      post({ source: ':::gate{key="g1" unlock="points" price="10"}\nSECRET-ROUTE 隐藏\n:::' }),
    );
    expect(await res.text()).not.toContain("SECRET-ROUTE");
  });
});
