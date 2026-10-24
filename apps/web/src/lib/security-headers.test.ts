import { describe, expect, it } from "vitest";
import { CSP_REPORT_PATH, buildCsp, buildSecurityHeaders } from "./security-headers";

const flat = (env: Parameters<typeof buildSecurityHeaders>[0]) =>
  buildSecurityHeaders(env).flatMap((r) => r.headers.map((h) => [h.key, h.value] as const));
const get = (env: Parameters<typeof buildSecurityHeaders>[0], key: string) =>
  flat(env).find(([k]) => k === key)?.[1];

describe("buildSecurityHeaders", () => {
  it("基线头齐全：nosniff、Referrer-Policy、X-Frame-Options、Permissions-Policy", () => {
    const env = { NODE_ENV: "production", APP_URL: "http://127.0.0.1:3100" };
    expect(get(env, "X-Content-Type-Options")).toBe("nosniff");
    expect(get(env, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(get(env, "X-Frame-Options")).toBe("DENY");
    expect(get(env, "Permissions-Policy")).toContain("camera=()");
  });

  it("CSP 只以 Report-Only 下发，不含强制的 Content-Security-Policy（转强制前须先看违规报告）", () => {
    const keys = flat({ NODE_ENV: "production" }).map(([k]) => k);
    expect(keys).toContain("Content-Security-Policy-Report-Only");
    expect(keys).not.toContain("Content-Security-Policy");
  });

  it("全部规则排除 /files/**：该路由自带更严的 CSP sandbox，不能被叠加或覆盖", () => {
    for (const rule of buildSecurityHeaders({ NODE_ENV: "production" })) {
      const re = new RegExp(`^${rule.source.replace(/^\//, "/")}$`);
      expect(re.test("/files/ab/cd/x.png")).toBe(false);
      expect(re.test("/")).toBe(true);
      expect(re.test("/t/1")).toBe(true);
      expect(re.test("/filesystem")).toBe(true); // 对照：只排除 /files/ 前缀，不误伤同前缀的别的路径
    }
  });

  describe("HSTS", () => {
    it("生产 + https 站点才下发", () => {
      expect(
        get(
          { NODE_ENV: "production", APP_URL: "https://bbs.example.com" },
          "Strict-Transport-Security",
        ),
      ).toBe("max-age=15552000");
    });
    it("对照：http 站点、开发 / 测试环境、未设置 APP_URL 都不下发", () => {
      for (const env of [
        { NODE_ENV: "production", APP_URL: "http://127.0.0.1:3100" },
        { NODE_ENV: "production" },
        { NODE_ENV: "development", APP_URL: "https://bbs.example.com" },
        { NODE_ENV: "test", APP_URL: "https://bbs.example.com" },
      ])
        expect(get(env, "Strict-Transport-Security"), JSON.stringify(env)).toBeUndefined();
    });
  });
});

describe("buildCsp", () => {
  it("硬性指令：object-src none、base-uri / form-action self、frame-ancestors none、上报地址", () => {
    const csp = buildCsp({ NODE_ENV: "production" });
    for (const d of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      `report-uri ${CSP_REPORT_PATH}`,
    ])
      expect(csp.split("; "), d).toContain(d);
  });

  it("生产不含 unsafe-eval；开发才有（React Refresh）", () => {
    expect(buildCsp({ NODE_ENV: "production" })).not.toContain("unsafe-eval");
    expect(buildCsp({ NODE_ENV: "development" })).toContain("'unsafe-eval'");
    expect(buildCsp({ NODE_ENV: "production" })).not.toMatch(/\bws:/);
  });

  it("不放行任何外部脚本源：script-src 只有 self 与 unsafe-inline", () => {
    const script = buildCsp({ NODE_ENV: "production" })
      .split("; ")
      .find((d) => d.startsWith("script-src "))!;
    expect(script).toBe("script-src 'self' 'unsafe-inline'");
  });
});
