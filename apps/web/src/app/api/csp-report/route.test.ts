import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { POST, extractReports, redactUri } from "./route";

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
    expect(row!["blocked-uri"]).toBe("[other]"); // 非 URL 非关键字的值不原样记录
    const [row2] = extractReports({ "csp-report": { "violated-directive": "a\r\nb\u0000c" } });
    expect(row2!["violated-directive"]).toBe("a  b c");
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

describe("redactUri（日志里不得出现令牌与查询串）", () => {
  const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdE";

  it("令牌路由：/reset /claim /verify 的令牌段被替换，查询串与片段被丢弃", () => {
    for (const route of ["reset", "claim", "verify"])
      expect(redactUri(`http://127.0.0.1:3200/${route}/${TOKEN}?error=x&t=${TOKEN}#frag`)).toBe(
        `http://127.0.0.1:3200/${route}/:token`,
      );
  });

  it("任何路径里看起来不透明的长段（令牌、sha256 存储键）都被替换，普通路径原样保留（对照）", () => {
    const sha = "a".repeat(64);
    expect(redactUri(`https://bbs.example.com/files/aa/aa/${sha}.png`)).toBe(
      "https://bbs.example.com/files/aa/aa/:token",
    );
    expect(redactUri("https://bbs.example.com/f/951?page=2")).toBe("https://bbs.example.com/f/951");
    expect(redactUri("https://bbs.example.com/t/950001")).toBe("https://bbs.example.com/t/950001");
    expect(redactUri("https://evil.test/x.png")).toBe("https://evil.test/x.png");
  });

  it("CSP 关键字原样保留；data: / blob: 只留协议；非 URL 的值一律 [other]", () => {
    for (const k of ["inline", "eval", "self"]) expect(redactUri(k)).toBe(k);
    expect(redactUri("data:image/png;base64,AAAA")).toBe("data:");
    expect(redactUri(`blob:http://x/${TOKEN}`)).toBe("blob:");
    for (const v of ["", "not a url", `${TOKEN}`, null, undefined, { a: 1 }])
      expect(redactUri(v), JSON.stringify(v)).toBe("[other]");
  });

  it("端到端：POST 带令牌路由的报告，日志里搜不到令牌也搜不到查询串", async () => {
    const res = await post({
      "csp-report": {
        "violated-directive": "img-src",
        "document-uri": `http://127.0.0.1:3200/reset/${TOKEN}?x=secret-query`,
        "blocked-uri": `https://evil.test/p?leak=${TOKEN}`,
        "source-file": `http://127.0.0.1:3200/claim/${TOKEN}`,
      },
    });
    expect(res.status).toBe(204);
    const logged = warn.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(logged).toContain("[csp-report]");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("secret-query");
    expect(logged).toContain("/reset/:token");
  });
});

describe("体积上限（流式）", () => {
  /** 不带 Content-Length 的分块请求体：每次 pull 给 8KB，记录被拉取的次数 */
  function chunkedRequest(totalChunks: number, pulled: { n: number }) {
    const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i++ >= totalChunks) controller.close();
        else {
          pulled.n++;
          controller.enqueue(chunk);
        }
      },
    });
    return new Request("http://x/api/csp-report", {
      method: "POST",
      body: stream,
      // Node 的 fetch 要求流式请求体显式声明 half duplex
      duplex: "half",
    } as RequestInit);
  }

  it("分块传输、不声明 Content-Length 的超大请求：读到上限就取消，不会把整个请求体读进内存", async () => {
    const pulled = { n: 0 };
    const res = await POST(chunkedRequest(1000, pulled)); // 若全读完是 8MB
    expect(res.status).toBe(204);
    expect(pulled.n).toBeLessThan(10); // 16KB 上限 ≈ 2～3 个块；留余量
    expect(warn).not.toHaveBeenCalled();
  });

  it("对照：未超限的分块请求体照常处理（上限不是一刀切丢弃）", async () => {
    const body = JSON.stringify({ "csp-report": { "violated-directive": "img-src" } });
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 10));
        c.enqueue(bytes.slice(10));
        c.close();
      },
    });
    const res = await POST(
      new Request("http://x/api/csp-report", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
