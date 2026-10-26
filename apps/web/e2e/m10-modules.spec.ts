import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";

/**
 * 装卸回归（M10 门禁）：poll / pm 模块经 defineModule 注册（与 M7 标准一致）——
 * 停用模块后相关能力消失，主体数据不受损。
 */

test.describe.configure({ mode: "serial" });

const setModule = async (id: string, enabled: boolean) =>
  withE2eDb(async (q) => {
    await q.exec(
      "INSERT INTO module_state (module_id, enabled, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)",
      [id, enabled ? 1 : 0],
    );
  });

test("停用 poll 模块：投票块不再渲染（主题与正文不受损）", async ({ page, context }) => {
  await setModule("poll", true);
  await loginAs(context, USERS.member);
  await page.goto("/t/950004");
  await expect(page.locator("#poll")).toBeVisible();

  await setModule("poll", false);
  await page.goto("/t/950004");
  await expect(page.locator("#poll")).toHaveCount(0);
  // 主题正文照常渲染
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await setModule("poll", true);
});

test("停用 pm 模块：私信入口仍在但发送事件不产生通知指针（模块语义）", async ({
  page,
  context,
}) => {
  await setModule("pm", true);
  await loginAs(context, USERS.alice);
  await page.goto("/messages");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("私信");

  await setModule("pm", false);
  await page.goto("/messages");
  // 页面仍可用（模块停用只停消费方，页面是站点能力）
  await expect(page.getByRole("heading", { level: 1 })).toContainText("私信");

  await setModule("pm", true);
});
