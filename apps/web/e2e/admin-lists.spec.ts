import { expect, test } from "@playwright/test";
import { USERS, loginAs } from "./support/session";

/**
 * M19 S4：后台列表多尺寸/密度/新筛选项的端到端验证——
 * users size/density 切换与筛选保持、logs 日期+targetType+actor（用户名反查）+CSV 参数、
 * invites 日期范围。核心审核/治理链路由 moderation-review / user-governance 覆盖。
 */

test.describe.configure({ mode: "serial" });

test("users：size 切到 50 → 每页 50 条、翻页保持；density 切紧凑 → URL 记忆", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await page.goto("/admin/users?size=50");
  await expect(page.getByRole("combobox", { name: "每页条数" })).toHaveValue("50");
  // 翻页保留 size
  const next = page.getByRole("link", { name: "下一页" });
  if (await next.count()) {
    await next.click();
    await expect(page).toHaveURL(/[?&]size=50/);
  }
  // 密度切紧凑：URL 记忆 + 按钮态
  await page.getByRole("link", { name: "紧凑" }).click();
  await expect(page).toHaveURL(/[?&]density=compact/);
  await expect(page.getByRole("link", { name: "紧凑" })).toHaveAttribute("aria-current", "true");
  await expect(page).toHaveURL(/[?&]size=50/);
});

test("logs：日期范围 + targetType + actor 用户名反查；CSV 链接同步透传", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await page.goto("/admin/logs?from=2026-01-01&to=2099-12-31");
  await expect(page.getByLabel("开始日期")).toHaveValue("2026-01-01");
  await expect(page.getByLabel("结束日期")).toHaveValue("2099-12-31");
  await expect(page.getByRole("combobox", { name: "按目标类型筛选" })).toBeVisible();
  // actor 用户名反查（M19 D4 搜索化）：输入片段 → 候选下拉 → 选中 demo_admin
  const actorBox = page.getByLabel("actor（用户名或 uid）");
  await actorBox.fill("demo_adm");
  await expect(page.getByRole("option", { name: "demo_admin (uid 90004)" })).toBeVisible();
  await page.getByRole("option", { name: "demo_admin (uid 90004)" }).click();
  await expect(actorBox).toHaveValue("demo_admin");
  await page.getByRole("button", { name: "筛选" }).click();
  await expect(page).toHaveURL(
    /from=2026-01-01&to=2099-12-31.*actor=demo_admin|actor=demo_admin.*from=2026-01-01/,
  );
  // CSV 导出链接透传日期与 actor（轮询等待 RSC 重渲染完成）
  const csv = page.getByRole("link", { name: "导出 CSV" });
  await expect(csv).toHaveAttribute("href", /from=2026-01-01/);
  await expect(csv).toHaveAttribute("href", /to=2099-12-31/);
  // CSV 链接带服务端解析后的数字 uid（页面 URL 保留用户名原文）
  await expect(csv).toHaveAttribute("href", /actor=90004/);
});

test("invites：日期范围筛选生效（空集与全量两态）", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  const totalAll = await (async () => {
    await page.goto("/admin/invites");
    const text = await page.getByText(/共 \d+ 枚/).innerText();
    return Number(text.match(/共 (\d+) 枚/)![1]);
  })();
  // 未来日期 → 空集（total=0 且无批次时页面文案为「还没有邀请码」）
  await page.goto("/admin/invites?from=2999-01-01&to=2999-12-31");
  await expect(page.getByText("还没有邀请码")).toBeVisible();
  // 全历史 → 与全量一致
  await page.goto("/admin/invites?to=2999-12-31");
  await expect(page.getByText(`共 ${totalAll} 枚`)).toBeVisible();
});
