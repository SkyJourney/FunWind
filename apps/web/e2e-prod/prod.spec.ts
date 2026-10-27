import { expect, test } from "@playwright/test";
import { withE2eDb } from "../e2e/support/db";
import { FIX } from "../e2e/support/fixtures";

/**
 * 生产模式冒烟（真实 next build + next start，端口 3201，TRUSTED_PROXY_HOPS=0 已声明）。
 * 这些行为只有生产构建才有，dev 服务器上的 E2E 无法证明：
 *   · 开发入口（/api/dev/*、/design）不可达；
 *   · 业务页面、门控、/files 安全响应头在生产构建下照常；
 *   · 生产下真实登录路径可用（IP 取不到时跳过 IP 级限额而不是报错）。
 */

test.describe("生产构建", () => {
  test("开发入口全部 404：/api/dev/*（含 POST）与 /design", async ({ request }) => {
    expect((await request.get("/api/dev/whoami")).status()).toBe(404);
    expect(
      (
        await request.post("/api/dev/emit", {
          data: { event: "user.logged_in", payload: { userId: 1 } },
        })
      ).status(),
    ).toBe(404);
    expect((await request.get("/api/dev/modules/toggle")).status()).toBe(404);
    expect(
      (
        await request.post("/api/dev/modules/toggle", {
          data: { id: "checkin", enabled: false },
        })
      ).status(),
    ).toBe(404);
    expect((await request.get("/design")).status()).toBe(404);
  });

  test("dev 入口的 404 不是空操作：模块启停状态没有被 POST 改动", async ({ request }) => {
    await request.post("/api/dev/modules/toggle", { data: { id: "checkin", enabled: false } });
    const rows = await withE2eDb((q) =>
      q.query("SELECT enabled FROM module_state WHERE module_id = 'checkin' AND enabled = 0"),
    );
    expect(rows).toEqual([]);
  });

  test("首页正常，且不露出设计令牌链接", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("青翼字幕组");
    await expect(page.getByText("设计令牌")).toHaveCount(0);
  });

  test("P0：受限版块与受限主题在生产构建下对游客同样 404，首页无其名称", async ({ page }) => {
    for (const p of [`/f/${FIX.staff.id}`, "/f/904", "/t/900005"]) {
      expect((await page.goto(p))?.status(), p).toBe(404);
    }
    await page.goto("/");
    const html = await page.content();
    expect(html).not.toContain(FIX.staff.name);
    expect(html).not.toContain("『字幕组内部区』");
  });

  test("门控：游客只看到锁卡片，页面无隐藏文本", async ({ page }) => {
    await page.goto("/t/900004");
    await expect(page.locator('[data-gate-state="locked"]')).toHaveCount(2);
    expect(await page.content()).not.toContain("需要 10 积分才能解锁的隐藏正文");
  });

  test("/files：图片带安全响应头；非法 key 与旧路由 404", async ({ request }) => {
    const [row] = await withE2eDb((q) =>
      q.query<{ storage_key: string; mime: string }>(
        "SELECT storage_key, mime FROM files WHERE mime LIKE 'image/%' ORDER BY id LIMIT 1",
      ),
    );
    const res = await request.get(`/files/${row!.storage_key}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers()["content-type"]).toBe(row!.mime);
    expect((await request.get("/files/aa/aa/xx.png")).status()).toBe(404);
    expect((await request.get("/attachment/x")).status()).toBe(404);
  });

  test("生产下真实登录路径可用：错误密码得到统一话术（不 500）；未登录访问后台被引到登录页", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill("nobody_prod_smoke");
    await page.getByLabel("密码", { exact: true }).fill("whatever-password-1");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("用户名或密码错误")).toBeVisible();

    await page.goto("/admin/authz");
    await expect(page).toHaveURL(/\/login/);
  });

  test("安全响应头（M5.6 S4）：基线头 + CSP Report-Only（生产不含 unsafe-eval），不暴露 X-Powered-By", async ({
    request,
  }) => {
    for (const p of ["/", "/login", `/f/${FIX.anime.id}`]) {
      const h = (await request.get(p)).headers();
      expect(h["x-content-type-options"], p).toBe("nosniff");
      expect(h["x-frame-options"], p).toBe("DENY");
      expect(h["referrer-policy"], p).toBe("strict-origin-when-cross-origin");
      expect(h["x-powered-by"], p).toBeUndefined();
      expect(h["content-security-policy"], p).toBeUndefined(); // 还是 Report-Only
      const csp = h["content-security-policy-report-only"]!;
      expect(csp, p).toContain("frame-ancestors 'none'");
      expect(csp, p).not.toContain("unsafe-eval");
      expect(h["strict-transport-security"], p).toBeUndefined(); // 冒烟站点是 http
    }
  });

  test("真实 next build 下，主要页面在这套 CSP 下零违规（生产的内联脚本与开发不同，必须单独实测）", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        w.__csp.push(`${e.violatedDirective} ← ${e.blockedURI || "inline"}`);
      });
    });
    const found: string[] = [];
    for (const p of [
      "/",
      "/login",
      "/register",
      `/f/${FIX.anime.id}`,
      `/t/${FIX.thread.emoji}`,
      `/t/${FIX.thread.image}`,
      `/t/${FIX.thread.gfm}`,
      "/t/900004",
    ]) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      const v = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
      for (const x of v) found.push(`${p}: ${x}`);
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  test("/files 路径穿越变体在生产构建下同样 404（%2e%2e、%2f 别名、反斜杠、截断）", async ({
    request,
  }) => {
    const [row] = await withE2eDb((q) =>
      q.query<{ storage_key: string }>(
        "SELECT storage_key FROM files WHERE mime LIKE 'image/%' ORDER BY id LIMIT 1",
      ),
    );
    const [d1, d2, file] = row!.storage_key.split("/");
    expect((await request.get(`/files/${row!.storage_key}`)).status()).toBe(200); // 对照
    // 注意：Playwright 的 request 会先把 %2e%2e 规范化掉，所以这里只放它不会改写的形态；
    // 完整的原始 HTTP 变体矩阵在 e2e/files-traversal.spec.ts（dev 服务器）
    for (const p of [
      `/files/${d1}%2f${d2}/${file}`,
      `/files/${d1}%2F${d2}%2F${file}`,
      `/files/${d1}/${d2}/${file}%00.png`,
      `/files/${d1}/${d2}/${file}%20`,
      `/files/..%5c..%5cetc%5cpasswd`,
      `/files/%252e%252e/%252e%252e/etc/passwd`,
    ]) {
      expect((await request.get(p)).status(), p).toBe(404);
    }
  });
});
