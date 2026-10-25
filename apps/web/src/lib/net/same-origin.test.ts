// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isSameOrigin } from "./same-origin";

const req = (headers: Record<string, string>, url = "http://localhost:3200/api/upload") =>
  new Request(url, { method: "POST", headers });

describe("isSameOrigin", () => {
  it("Origin 与 Host 一致（request.url 是 localhost 也不影响）：同源", () => {
    expect(isSameOrigin(req({ origin: "http://127.0.0.1:3200", host: "127.0.0.1:3200" }))).toBe(
      true,
    );
  });

  it("反向代理：X-Forwarded-Proto 决定协议", () => {
    expect(
      isSameOrigin(
        req({
          origin: "https://forum.example",
          host: "forum.example",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe(true);
    expect(isSameOrigin(req({ origin: "https://forum.example", host: "forum.example" }))).toBe(
      false,
    );
  });

  it("跨站：Origin 是别的站点，Host 是本站 → 拒绝", () => {
    expect(isSameOrigin(req({ origin: "https://evil.example", host: "127.0.0.1:3200" }))).toBe(
      false,
    );
  });

  it("无 Host 头时回落到 request.url 的主机", () => {
    expect(
      isSameOrigin(
        new Request("http://127.0.0.1:3100/api/x", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:3100" },
        }),
      ),
    ).toBe(true);
  });

  it("不带 Origin：放行（非浏览器请求，沿用既有规则）", () => {
    expect(isSameOrigin(req({}))).toBe(true);
  });
});
