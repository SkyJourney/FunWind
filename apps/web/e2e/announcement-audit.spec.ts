import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { loginAs, USERS } from "./support/session";

test("站点框架（M19 迁至站点配置）：页脚保存 → 审计 + 前台即时生效", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const text = `E2E 页脚 ${Date.now()}`;

  // 前台页脚区块仅在 site.links 非空时渲染——先补一条友链（记下原值用于还原）
  const prevLinks = await withE2eDb((q) =>
    q.query<{ value: unknown }>("SELECT value FROM site_settings WHERE `key` = 'site.links'"),
  );
  if (!prevLinks[0]) {
    await withE2eDb(async (q) =>
      q.exec(
        "INSERT INTO site_settings (`key`, value, updated_at) VALUES ('site.links', ?, NOW())",
        JSON.stringify([{ label: "E2E 友链", href: "https://e2e.example" }]),
      ),
    );
  }

  try {
    await loginAs(context, USERS.admin);
    await page.goto("/admin/settings");
    await page.getByRole("link", { name: "站点框架" }).click();
    await page.getByPlaceholder("版权/备案/联系方式等纯文本").fill(text);
    await page.getByRole("button", { name: "保存页脚" }).click();
    await page.waitForURL("**/admin/settings?saved=footer*");
    await expect(page.getByText("页脚已保存并即时生效。")).toBeVisible();

    // 前台全站页脚出现新文案（保存页脚失效 chrome 缓存，重取时带上刚补的友链）
    await page.goto("/");
    await expect(page.getByText(text)).toBeVisible();
  } finally {
    // 还原页脚为空与友链原状，避免影响后续用例/快照
    await page.goto("/admin/settings");
    await page.getByPlaceholder("版权/备案/联系方式等纯文本").fill("");
    await page.getByRole("button", { name: "保存页脚" }).click();
    await page.waitForURL("**/admin/settings?saved=footer*");
    if (!prevLinks[0]) {
      await withE2eDb(async (q) => q.exec("DELETE FROM site_settings WHERE `key` = 'site.links'"));
    }
    await context.close();
  }
});

test("公告创建、编辑、下线均在对应事务写审计", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const title = `E2E 审计公告 ${Date.now()}`;
  const editedTitle = `${title}（已编辑）`;

  try {
    await loginAs(context, USERS.admin);
    await page.goto("/admin/announcements");
    await expect(page.getByText("发布公告", { exact: true })).toBeVisible();

    await page.getByPlaceholder("标题").fill(title);
    await page.getByPlaceholder("正文（Markdown）").fill("E2E 审计回归正文。");
    await page.getByLabel("开始时间（默认现在）").fill("2099-01-01T00:00");
    await page.getByLabel("受众").selectOption("members");
    await page.getByRole("button", { name: "发布", exact: true }).click();
    await page.waitForURL("**/admin/announcements?created=1");

    const created = await withE2eDb((q) =>
      q.query<{ id: number }>("SELECT id FROM announcements WHERE title = ?", [title]),
    );
    expect(created).toHaveLength(1);
    const announcementId = created[0]!.id;
    const row = page.getByRole("listitem").filter({ hasText: title });
    await expect(row).toContainText("未开始");
    const createAudits = await withE2eDb((q) =>
      q.query<{ action: string }>(
        "SELECT action FROM audit_log WHERE target_type = ? AND target_id = ?",
        ["announcement", String(announcementId)],
      ),
    );
    expect(createAudits.map((audit) => audit.action)).toContain("announcement.create");

    await row.getByRole("link", { name: "编辑" }).click();
    await page.waitForURL(new RegExp(`\\?edit=${announcementId}$`));
    await page.getByPlaceholder("标题").fill(editedTitle);
    await page.getByPlaceholder("正文（Markdown）").fill("E2E 审计回归正文已编辑。");
    await page.getByRole("button", { name: "保存修改" }).click();
    await page.waitForURL("**/admin/announcements?updated=1");

    const editedRow = page.getByRole("listitem").filter({ hasText: editedTitle });
    await expect(editedRow).toContainText("未开始");
    const editAudits = await withE2eDb((q) =>
      q.query<{ action: string }>(
        "SELECT action FROM audit_log WHERE target_type = ? AND target_id = ?",
        ["announcement", String(announcementId)],
      ),
    );
    expect(editAudits.map((audit) => audit.action)).toContain("announcement.edit");

    await editedRow.getByRole("button", { name: "下线" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "确认" }).click();
    await page.waitForURL("**/admin/announcements?ended=1");
    await expect(page.getByRole("listitem").filter({ hasText: editedTitle })).toContainText(
      "已结束",
    );

    const finalAudits = await withE2eDb((q) =>
      q.query<{ action: string }>(
        "SELECT action FROM audit_log WHERE target_type = ? AND target_id = ? ORDER BY id",
        ["announcement", String(announcementId)],
      ),
    );
    expect(finalAudits.map((audit) => audit.action)).toEqual([
      "announcement.create",
      "announcement.edit",
      "announcement.end",
    ]);
  } finally {
    await withE2eDb(async (q) => {
      const rows = await q.query<{ id: number }>(
        "SELECT id FROM announcements WHERE title IN (?, ?)",
        [title, editedTitle],
      );
      for (const { id } of rows) {
        await q.exec("DELETE FROM audit_log WHERE target_type = ? AND target_id = ?", [
          "announcement",
          String(id),
        ]);
        await q.exec("DELETE FROM announcements WHERE id = ?", [id]);
      }
    });
    await context.close();
  }
});
