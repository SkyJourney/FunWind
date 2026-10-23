import { expect, test } from "@playwright/test";

// 装卸状态共享同一 dev 服务器与 module_state 表：两用例必须串行
test.describe.configure({ mode: "serial" });

test.describe("M2 · 模块装卸闭环（demo-checkin）", () => {
  test("启用 + 事件派发 → 槽位横幅出现；宿主页不受影响", async ({ request, page }) => {
    // 1. 启用模块（显式置态，保证用例独立）
    const on = await request.post("/api/dev/modules/toggle", {
      data: { id: "demo-checkin", enabled: true },
    });
    expect(on.ok()).toBeTruthy();

    // 2. 派发假登录事件（假会话；M4 之前无真实登录）
    const emit = await request.post("/api/dev/emit", {
      data: { event: "user.logged_in", payload: { userId: 90001 } },
    });
    expect(emit.ok()).toBeTruthy();
    const emitBody = await emit.json();
    expect(emitBody.logged).toBe(true); // event_log 审计落库成功

    // 3. 槽位横幅出现（事件→event_log→Slot 全链路）
    await page.goto("/");
    await expect(page.getByText(/demo-checkin/)).toBeVisible();
    // 4. 装卸不影响宿主页
    await expect(page.getByRole("heading", { level: 1 })).toContainText("青翼字幕组");
  });

  test("禁用 → 横幅消失，宿主页正常渲染", async ({ request, page }) => {
    const off = await request.post("/api/dev/modules/toggle", {
      data: { id: "demo-checkin", enabled: false },
    });
    expect(off.ok()).toBeTruthy();

    await page.goto("/");
    await expect(page.getByText(/demo-checkin/)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("青翼字幕组");

    // 恢复启用（默认态），避免污染后续用例
    await request.post("/api/dev/modules/toggle", { data: { id: "demo-checkin", enabled: true } });
  });
});
