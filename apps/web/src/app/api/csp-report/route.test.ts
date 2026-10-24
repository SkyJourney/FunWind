import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { POST, extractReports } from "./route";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://x/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetRateLimiter();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe("extractReports", () => {
  it("旧格式 {csp-report: {...}}", () => {
    expect(
      extractReports({
        "csp-report": { "violated-directive": "img-src", "blocked-uri": "https://evil.test/x.png" },
      }),
    ).toEqual([{ "violated-directive": "img-src", "blocked-uri": "https://evil.test/x.png" }]);
  });

  it("Reporting API 格式：数组、body 里是驼峰字段", () => {
    expect(
      extractReports([
        { type: "csp-violation", body: { violatedDirective: "script-src", blockedURL: "x" } },
      ]),
    ).toEqual([{ "violated-directive": "script-src" }]);
  });

  it("无关 / 畸形输入得到空数组；一次最多取 10 条；字段截断到 200 字符并去掉控制字符", () => {
    expect(extractReports(null)).toEqual([]);
    expect(extractReports({ foo: 1 })).toEqual([]);
    expect(extractReports("x")).toEqual([]);
    const many = Array.from({ length: 50 }, () => ({ "csp-report": { "blocked-uri": "a" } }));
    expect(extractReports(many)).toHaveLength(10);
    const [row] = extractReports({
      "csp-report": { "blocked-uri": `${"a".repeat(500)}\r\n[csp-report] 伪造的日志行` },
    });
    expect(row!["blocked-uri"]).toHaveLength(200);
    const [row2] = extractReports({ "csp-report": { "blocked-uri": "a\r\nb\u0000c" } });
    expect(row2!["blocked-uri"]).toBe("a  b c");
  });
});

describe("POST /api/csp-report", () => {
  it("正常报告：记一行日志，返回 204", async () => {
    const res = await post({ "csp-report": { "violated-directive": "img-src" } });
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("[csp-report]");
  });

  it("无论输入如何都是 204、不抛错、不泄露状态：畸形 JSON、空体、非对象", async () => {
    for (const body of ["{不是json", "", "null", "123", '"str"']) {
      const res = await post(body);
      expect(res.status, body).toBe(204);
      expect(await res.text()).toBe("");
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("体积上限：声明超过 16KB 的请求直接丢弃，不解析不记日志（对照：小体积同样内容会记）", async () => {
    const report = { "csp-report": { "violated-directive": "img-src" } };
    const res = await post(report, { "content-length": String(64 * 1024) });
    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
    await post(report);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("频控：同一来源每分钟最多处理 30 份，超出静默丢弃（不能变成刷日志的入口）", async () => {
    const report = { "csp-report": { "violated-directive": "img-src" } };
    for (let i = 0; i < 40; i++) expect((await post(report)).status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(30);
  });
});
