import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";

// 装卸状态共享同一 dev 服务器与 module_state 表：两用例必须串行
test.describe.configure({ mode: "serial" });

test.describe("模块装卸闭环（checkin，M7 起为真实模块）", () => {
  test("启用 → 首页签到条出现；宿主页不受影响；dev emit 落 event_log", async ({
    request,
    page,
  }) => {
    // 1. 启用模块（显式置态，保证用例独立）
    const on = await request.post("/api/dev/modules/toggle", {
      data: { id: "checkin", enabled: true },
    });
    expect(on.ok()).toBeTruthy();

    // 2. dev emit：校验载荷后经内核总线派发，event_log 审计落库
    const emit = await request.post("/api/dev/emit", {
      data: { event: "user.logged_in", payload: { userId: 90001 } },
    });
    expect(emit.ok()).toBeTruthy();
    const emitBody = await emit.json();
    expect(emitBody.logged).toBe(true); // event_log 审计落库成功

    // 3. 签到条出现（Slot 渲染；游客看到登录引导——不泄露任何他人活动）
    await page.goto("/");
    await expect(page.getByText(/每日签到|今日未签到|今日已签到/).first()).toBeVisible();
    // 4. 装卸不影响宿主页
    await expect(page.getByRole("heading", { level: 1 })).toContainText("青翼字幕组");
  });

  test("禁用 → 签到条消失，宿主页正常渲染", async ({ request, page }) => {
    const off = await request.post("/api/dev/modules/toggle", {
      data: { id: "checkin", enabled: false },
    });
    expect(off.ok()).toBeTruthy();

    await page.goto("/");
    await expect(page.getByText(/每日签到|今日未签到|今日已签到/)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("青翼字幕组");

    // 恢复启用（默认态），避免污染后续用例
    await request.post("/api/dev/modules/toggle", { data: { id: "checkin", enabled: true } });
  });
});

test.describe("真实登录驱动事件（不再靠 dev 接口伪造）", () => {
  const loggedInEvents = () =>
    withE2eDb((q) =>
      q.query<{ actor_id: number | null; source: string | null }>(
        "SELECT actor_id, source FROM event_log WHERE event_name = 'user.logged_in' ORDER BY id",
      ),
    );

  test("界面登录成功 → 派发 user.logged_in（行为人=登录者，来源=auth）→ 签到条出现；登录失败不派发", async ({
    page,
  }) => {
    await withE2eDb((q) => q.exec("DELETE FROM event_log WHERE event_name = 'user.logged_in'"));

    // 密码错误：不得派发事件
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill("demo_member");
    await page.getByLabel("密码").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("用户名或密码错误")).toBeVisible();
    expect(await loggedInEvents()).toEqual([]);

    // 真实登录
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill("demo_admin");
    await page.getByLabel("密码").fill("e2e-admin-pass");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByRole("button", { name: "demo_admin" })).toBeVisible();

    expect(await loggedInEvents()).toEqual([{ actor_id: 90004, source: "auth" }]);
    await page.goto("/");
    await expect(page.getByText(/今日未签到|今日已签到/).first()).toBeVisible();
  });
});
