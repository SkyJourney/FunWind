import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { POST } from "./route";

/**
 * RUM 上报端点（M17 Step 4）。落库替身掉，专注验端点自己的职责：
 * 防线顺序、恒 204、脱敏、校验。**脱敏用真实 redactUri**（不 mock），
 * 因为「裸路径被 redactUri 判为非 URL 而变成 [other]」正是本端点最容易静默出错的地方。
 */
const recordRumSamples = vi.hoisted(() => vi.fn(async (rows: readonly unknown[]) => rows.length));
vi.mock("@/lib/rum/ingest", () => ({ recordRumSamples }));

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://x/api/rum", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const vital = (over: Record<string, unknown> = {}) => ({
  kind: "vital",
  name: "LCP",
  value: 1234,
  route: "/t/6621",
  ...over,
});
const payload = (samples: unknown[]) => ({ v: 1, samples });
const rows = () => recordRumSamples.mock.calls.at(-1)?.[0] as Record<string, unknown>[];

beforeEach(() => {
  resetRateLimiter();
  recordRumSamples.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("恒 204 且不泄露状态", () => {
  it("合法载荷：204 无响应体，落库一次", async () => {
    const res = await post(payload([vital()]));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(recordRumSamples).toHaveBeenCalledTimes(1);
    expect(rows()[0]).toMatchObject({ kind: "vital", name: "LCP", value: 1234, route: "/t/6621" });
  });

  it.each([
    ["畸形 JSON", "{不是 json"],
    ["空样本", payload([])],
    ["版本不对", { v: 2, samples: [vital()] }],
    ["kind/name 不匹配", payload([vital({ name: "js-error" })])],
    ["value 超限", payload([vital({ value: 999_999 })])],
  ])("%s：仍 204，且不落库", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(204);
    expect(recordRumSamples).not.toHaveBeenCalled();
  });

  it("跨站 Origin：204 但不落库", async () => {
    const res = await post(payload([vital()]), { origin: "https://evil.test", host: "x" });
    expect(res.status).toBe(204);
    expect(recordRumSamples).not.toHaveBeenCalled();
  });

  it("落库抛错不反噬：仍 204", async () => {
    recordRumSamples.mockRejectedValueOnce(new Error("db down"));
    const res = await post(payload([vital()]));
    expect(res.status).toBe(204);
  });
});

describe("脱敏（本端点最易静默出错处）", () => {
  it("裸路径必须正确保留，不能变成 [other]", async () => {
    await post(payload([vital({ route: "/t/6621" })]));
    expect(rows()[0]!.route).toBe("/t/6621");
  });

  it("路径里的一次性令牌段替换为 :token", async () => {
    await post(payload([vital({ route: "/reset/abcdefghijklmnopqrstuvwxyz123456" })]));
    expect(rows()[0]!.route).toBe("/reset/:token");
  });

  it("查询串与片段被丢弃（令牌常在查询串里）", async () => {
    await post(payload([vital({ route: "/t/6621?token=secret#frag" })]));
    expect(rows()[0]!.route).toBe("/t/6621");
  });

  it("客户端无法注入任意 origin（固定 base 剥离）", async () => {
    await post(payload([vital({ route: "https://evil.test/x" })]));
    expect(String(rows()[0]!.route)).not.toContain("evil.test");
  });

  it("error 的 detail 去控制字符并截断到 200", async () => {
    const detail = `boom\r\n[rum] 伪造行${"x".repeat(400)}`;
    await post(payload([{ kind: "error", name: "js-error", value: 0, route: "/x", detail }]));
    const out = String(rows()[0]!.detail);
    expect(out).toHaveLength(200);
    expect(out).not.toMatch(/[\r\n]/);
  });

  it("error 的 detail 内嵌令牌 URL 被脱敏（审查 A-P2-2）", async () => {
    const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdE";
    const detail = `Failed to fetch https://bbs.example.com/reset/${token}?x=secret 后续文本`;
    await post(payload([{ kind: "error", name: "js-error", value: 0, route: "/x", detail }]));
    const out = String(rows()[0]!.detail);
    expect(out).not.toContain(token);
    expect(out).not.toContain("secret");
    expect(out).toContain("/reset/:token");
  });

  it("vital 行不带 detail（即使客户端夹带）", async () => {
    await post(payload([vital({ detail: "夹带" })]));
    expect(rows()[0]!.detail).toBeNull();
  });

  it("error 未给 detail 时为 null", async () => {
    await post(payload([{ kind: "error", name: "js-error", value: 0, route: "/x" }]));
    expect(rows()[0]!.detail).toBeNull();
  });
});

describe("体积与频控", () => {
  it("声明体积超限：204 且不落库（不整包读进内存）", async () => {
    const res = await post(payload([vital()]), { "content-length": "999999" });
    expect(res.status).toBe(204);
    expect(recordRumSamples).not.toHaveBeenCalled();
  });

  it("IP 频控 60/分：超出后 204 且不落库", async () => {
    for (let i = 0; i < 60; i += 1) await post(payload([vital()]));
    expect(recordRumSamples).toHaveBeenCalledTimes(60);
    const res = await post(payload([vital()]));
    expect(res.status).toBe(204);
    expect(recordRumSamples).toHaveBeenCalledTimes(60);
  });

  it("默认不信任 XFF（TRUSTED_PROXY_HOPS 未设=0）：伪造头不能绕过 IP 限额", async () => {
    // 这是安全性质：未声明可信代理层数时，XFF 完全不可信，所有请求共用同一个桶
    for (let i = 0; i < 60; i += 1) {
      await post(payload([vital()]), { "x-forwarded-for": `1.1.1.${i}` });
    }
    const res = await post(payload([vital()]), { "x-forwarded-for": "9.9.9.9" });
    expect(res.status).toBe(204);
    expect(recordRumSamples).toHaveBeenCalledTimes(60);
  });

  it("声明可信代理后不同 IP 各自计数（互不影响）", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    try {
      for (let i = 0; i < 60; i += 1) {
        await post(payload([vital()]), { "x-forwarded-for": "1.1.1.1" });
      }
      await post(payload([vital()]), { "x-forwarded-for": "2.2.2.2" });
      expect(recordRumSamples).toHaveBeenCalledTimes(61);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
