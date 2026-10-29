import { expect, test, type Page } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { USERS, loginAs } from "./support/session";

/**
 * 安全响应头（M5.6 S4）。
 *   · 基线头在业务页上齐全，CSP 只以 Report-Only 下发（不拦截任何东西）；
 *   · /files/** 保持自己更严的 CSP sandbox，不被全站头叠加；
 *   · **实测各主要页面在这套 CSP 下不产生任何违规**——这是以后把 Report-Only 转强制的前提。
 *     违规靠浏览器的 securitypolicyviolation 事件收集（Report-Only 的违规同样会触发）。
 */

async function collectViolations(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp.push(
        `${e.violatedDirective} ← ${e.blockedURI || "inline"} @ ${e.sourceFile || location.pathname}`,
      );
    });
  });
}
const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test.describe("响应头", () => {
  for (const p of ["/", "/login", `/f/${FIX.anime.id}`, `/t/${FIX.thread.emoji}`, "/register"]) {
    test(`${p}：基线头齐全，CSP 为 Report-Only，不暴露 X-Powered-By`, async ({ request }) => {
      const res = await request.get(p);
      expect(res.status()).toBe(200);
      const h = res.headers();
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["x-frame-options"]).toBe("DENY");
      expect(h["permissions-policy"]).toContain("camera=()");
      expect(h["x-powered-by"]).toBeUndefined();
      expect(h["content-security-policy-report-only"]).toContain("frame-ancestors 'none'");
      expect(h["content-security-policy-report-only"]).toContain("report-uri /api/csp-report");
      expect(h["content-security-policy"]).toBeUndefined(); // 还没转强制
      expect(h["strict-transport-security"]).toBeUndefined(); // http 站点不下发 HSTS
    });
  }

  test("/files/**：只有自己的 CSP sandbox，没有叠加全站 CSP / X-Frame-Options", async ({
    page,
    request,
  }) => {
    await page.goto(`/t/${FIX.thread.image}`);
    const src = (await page
      .locator('.content-md img[src^="/files/"]')
      .first()
      .getAttribute("src"))!;
    const h = (await request.get(src)).headers();
    expect(h["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(h["content-security-policy-report-only"]).toBeUndefined();
    expect(h["x-frame-options"]).toBeUndefined();
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  test("/emoji/**：同样只有自己的 CSP sandbox + 不可变缓存（旧 50 枚静态文件）；全部分支见 emoji-serving.spec", async ({
    request,
  }) => {
    const h = (await request.get("/emoji/120.gif")).headers();
    expect(h["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(h["content-security-policy-report-only"]).toBeUndefined();
    expect(h["x-frame-options"]).toBeUndefined();
    expect(h["cache-control"]).toBe("public, max-age=31536000, immutable");
    // 表情帖（/t/{thread.emoji}）已在下方零违规页清单里：表情图作为子资源加载不产生 CSP 违规
  });

  test("/api/csp-report：任何输入都是 204 且没有响应体", async ({ request }) => {
    for (const data of [
      JSON.stringify({ "csp-report": { "violated-directive": "img-src", "blocked-uri": "x" } }),
      "{不是json",
      "",
    ]) {
      const res = await request.post("/api/csp-report", {
        headers: { "content-type": "application/csp-report" },
        data,
      });
      expect(res.status()).toBe(204);
      expect(await res.text()).toBe("");
    }
  });
});

test.describe("CSP 违规实测（Report-Only 下的预演：以后转强制不能破坏这些页面）", () => {
  const PUBLIC_PAGES = [
    "/",
    "/login",
    "/register",
    "/forgot",
    `/f/${FIX.anime.id}`,
    `/f/${FIX.water.id}`,
    `/t/${FIX.thread.emoji}`, // 表情
    `/t/${FIX.thread.image}`, // 正文图片
    `/t/${FIX.thread.attach}`, // 附件
    `/t/${FIX.thread.gfm}`, // 表格 / 删除线
    `/t/${FIX.thread.poll}`,
    `/t/${FIX.thread.gateAttach}`, // 门控
  ];

  test("游客浏览主要页面：零违规", async ({ page }) => {
    await collectViolations(page);
    const found: string[] = [];
    for (const p of PUBLIC_PAGES) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      for (const v of await violations(page)) found.push(`${p}: ${v}`);
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  test("管理员浏览后台页面：零违规", async ({ page, context }) => {
    await loginAs(context, USERS.admin);
    await collectViolations(page);
    const found: string[] = [];
    for (const p of ["/", "/admin", "/admin/authz", `/u/${USERS.admin}`]) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      for (const v of await violations(page)) found.push(`${p}: ${v}`);
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  test("对照：违规检测本身是灵的——注入一个外部脚本源会被记录", async ({ page }) => {
    await collectViolations(page);
    await page.goto("/login");
    await page.evaluate(() => {
      const s = document.createElement("script");
      s.src = "https://cdn.example.invalid/x.js";
      document.head.appendChild(s);
    });
    await expect.poll(() => violations(page)).toEqual([expect.stringContaining("script-src")]);
  });
});
