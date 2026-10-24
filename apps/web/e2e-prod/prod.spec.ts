import { expect, test } from "@playwright/test";
import { withE2eDb } from "../e2e/support/db";

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
          data: { id: "demo-checkin", enabled: false },
        })
      ).status(),
    ).toBe(404);
    expect((await request.get("/design")).status()).toBe(404);
  });

  test("dev 入口的 404 不是空操作：模块启停状态没有被 POST 改动", async ({ request }) => {
    await request.post("/api/dev/modules/toggle", { data: { id: "demo-checkin", enabled: false } });
    const rows = await withE2eDb((q) =>
      q.query("SELECT enabled FROM module_state WHERE module_id = 'demo-checkin' AND enabled = 0"),
    );
    expect(rows).toEqual([]);
  });

  test("首页正常，且不露出设计令牌链接", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("青翼字幕组");
    await expect(page.getByText("设计令牌")).toHaveCount(0);
  });

  test("P0：受限版块与受限主题在生产构建下对游客同样 404，首页无其名称", async ({ page }) => {
    for (const p of ["/f/121", "/f/904", "/t/900005"]) {
      expect((await page.goto(p))?.status(), p).toBe(404);
    }
    await page.goto("/");
    const html = await page.content();
    expect(html).not.toContain("『字幕制作组』");
    expect(html).not.toContain("『字幕组内部区』");
  });

  test("门控：游客只看到锁卡片，页面无隐藏文本", async ({ page }) => {
    await page.goto("/t/900004");
    await expect(page.locator('[data-gate-state="locked"]')).toHaveCount(2);
    expect(await page.content()).not.toContain("需要 10 积分才能解锁的隐藏正文");
  });

  test("/files：图片带安全响应头；非法 key 与旧路由 404", async ({ request }) => {
    const [row] = await withE2eDb((q) =>
      q.query<{ storage_key: string }>(
        "SELECT storage_key FROM files WHERE mime = 'image/jpeg' LIMIT 1",
      ),
    );
    const res = await request.get(`/files/${row!.storage_key}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers()["content-type"]).toBe("image/jpeg");
    expect((await request.get("/files/aa/aa/xx.png")).status()).toBe(404);
    expect((await request.get("/attachment/x")).status()).toBe(404);
  });

  test("生产下真实登录路径可用：错误密码得到统一话术（不 500）；未登录访问后台被引到登录页", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill("nobody_prod_smoke");
    await page.getByLabel("密码").fill("whatever-password-1");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("用户名或密码错误")).toBeVisible();

    await page.goto("/admin/authz");
    await expect(page).toHaveURL(/\/login/);
  });
});
