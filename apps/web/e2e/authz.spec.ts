import { expect, test } from "@playwright/test";

/**
 * M5 · 权限内核 E2E。
 * 夹具：fid 53 真·酱油无双（旧白名单仅 系统+团队角色，游客/普通会员不可读）/
 * demo_admin（90004，密码 e2e-admin-pass，admin 全局角色）/
 * demo_alice（90001，member，auth.spec 先行认领 alice-pass-789）。
 *
 * 注：admin 相关断言合并在单一用例内（只登录一次）——登录有频控，
 * 反复登录同一账号会触发限流使后续断言失真。
 */

test.describe("M5 · 权限内核", () => {
  test("隔离校验：E2E server 连接的是隔离库", async ({ request }) => {
    const r = await request.get("/api/dev/whoami");
    const body = (await r.json()) as { database: string };
    expect(body.database).toBe("qysub_next_e2e");
  });

  test("游客可读公开版块（白名单含 guest）", async ({ page }) => {
    await page.goto("/f/109");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("アニメ");
  });

  test("受限版块：游客 → 404（不暴露存在性）", async ({ page }) => {
    const res = await page.goto("/f/53");
    expect(res?.status()).toBe(404);
  });

  test("受限版块：普通会员 → 404", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill("demo_alice");
    await page.getByLabel("密码").fill("alice-pass-789");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByRole("link", { name: "demo_alice" })).toBeVisible();

    const res = await page.goto("/f/53");
    expect(res?.status()).toBe(404);
  });

  test("admin：可读受限版块 + 后台矩阵 + 版块视角（单次登录）", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill("demo_admin");
    await page.getByLabel("密码").fill("e2e-admin-pass");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByRole("link", { name: "demo_admin" })).toBeVisible();

    // ① 受限版块：admin 可读
    await page.goto("/f/53");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("酱油无双");

    // ② 后台：site.admin 总门放行
    await page.goto("/admin/authz");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("后台管理");

    // ③ 授权矩阵：进入 admin 角色可见权限点
    await page.getByRole("link", { name: "管理员" }).click();
    await expect(page).toHaveURL(/\/admin\/authz\/admin/);
    await expect(page.getByText("site.admin")).toBeVisible();
    await expect(page.getByText("admin.roles")).toBeVisible();

    // ④ 版块视角：派生版主 + 作用域链
    await page.goto("/admin/authz/forum/109");
    await expect(page.getByText("派生版主")).toBeVisible();
    await expect(page.getByText("作用域链")).toBeVisible();
  });
});
