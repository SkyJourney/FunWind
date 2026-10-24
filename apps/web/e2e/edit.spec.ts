import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";

/**
 * 编辑帖子 E2E（M6.2 第 4 步，桌面）。
 * 主题与帖子直接用 SQL 造在 954（公开、不审核）：作者 alice；门控帖的隐藏正文只对作者和版主可见。
 * 编辑不受发帖间隔限制，但同一帖子的用例会改库，所以每个用例自己的标题 / 正文都带时间戳。
 */

const THREAD = 960201;
const REPLY = 960302; // alice 的回帖（楼层 2）
const GATED_THREAD = 960202;
const GATED_FIRST = 960303; // 门控帖的首帖
const SECRET = "SECRET-EDIT-HIDDEN";

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    for (const tid of [THREAD, GATED_THREAD]) {
      await q.exec(
        "DELETE FROM post_gates WHERE post_id IN (SELECT id FROM posts WHERE thread_id = ?)",
        [tid],
      );
      await q.exec("DELETE FROM posts WHERE thread_id = ?", [tid]);
      await q.exec("DELETE FROM threads WHERE id = ?", [tid]);
    }
    await q.exec(
      `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, created_at, last_posted_at)
       VALUES (?, ?, ?, '[E2E] 可编辑的主题', ?, 'visible', '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
      [THREAD, FIX.compose.id, USERS.alice, THREAD + 100],
    );
    await q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
       VALUES (?, ?, 1, ?, '首帖原文', 0, 'visible', '2026-10-21 10:00:00'),
              (?, ?, 2, ?, '回帖原文', 0, 'visible', '2026-10-21 10:01:00')`,
      [THREAD + 100, THREAD, USERS.alice, REPLY, THREAD, USERS.alice],
    );
    await q.exec(
      `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, created_at, last_posted_at)
       VALUES (?, ?, ?, '[E2E] 带门控的主题', ?, 'visible', '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
      [GATED_THREAD, FIX.compose.id, USERS.alice, GATED_FIRST],
    );
    await q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
       VALUES (?, ?, 1, ?, ?, 1, 'visible', '2026-10-21 10:00:00')`,
      [GATED_FIRST, GATED_THREAD, USERS.alice, '公开前言\n\n:::gate{key="g1"}\n:::'],
    );
    await q.exec(
      `INSERT INTO post_gates (id, post_id, gate_key, conditions, match_mode, hidden_md, created_at, updated_at)
       VALUES (960401, ?, 'g1', ?, 'all', ?, '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
      [GATED_FIRST, JSON.stringify([{ type: "points", price: 10 }]), `${SECRET} 门控里的隐藏正文`],
    );
  });
});

test.describe("编辑帖子", () => {
  test("作者：主题页出现编辑入口，保存后跳到该回帖并看到新内容", async ({ page, context }) => {
    await loginAs(context, USERS.alice);
    await page.goto(`/t/${THREAD}`);
    await expect(page.locator(`a[href="/p/${REPLY}/edit"]`)).toBeVisible();

    await page.goto(`/p/${REPLY}/edit`);
    await expect(page.locator("#edit-source")).toHaveValue("回帖原文");
    const text = `E2E 改后的回帖 ${Date.now()}`;
    await page.locator("#edit-source").fill(text);
    await page.getByRole("button", { name: "保存修改" }).click();

    await expect(page).toHaveURL(new RegExp(`/t/${THREAD}(\\?page=\\d+)?#p${REPLY}$`));
    await expect(page.getByText(text)).toBeVisible();
  });

  test("冲突：另一窗口已保存过，旧表单保存被拒，展示最新版本且不覆盖", async ({ context }) => {
    await loginAs(context, USERS.alice);
    const a = await context.newPage();
    const b = await context.newPage();
    // 两个窗口同时打开编辑页：拿到同一个版本号
    await a.goto(`/p/${REPLY}/edit`);
    await b.goto(`/p/${REPLY}/edit`);

    const winner = `窗口 A 的修改 ${Date.now()}`;
    await a.locator("#edit-source").fill(winner);
    await a.getByRole("button", { name: "保存修改" }).click();
    await expect(a).toHaveURL(new RegExp(`#p${REPLY}$`));

    // 窗口 B 仍持有旧版本号：保存被拒，提示冲突，输入框是最新版本而不是 B 自己的草稿
    await b.locator("#edit-source").fill("窗口 B 的覆盖尝试");
    await b.getByRole("button", { name: "保存修改" }).click();
    await expect(b.locator('p[role="alert"]')).toHaveText(
      "这条内容刚刚被修改过，请刷新页面后再编辑。",
    );
    await expect(b.locator("#edit-source")).toHaveValue(winner);
    await b.close();
    await a.close();
  });

  test("门控帖：作者打开编辑页，正文是完整源码（含门控的隐藏正文）", async ({ page, context }) => {
    await loginAs(context, USERS.alice);
    await page.goto(`/p/${GATED_FIRST}/edit`);
    const value = await page.locator("#edit-source").inputValue();
    expect(value).toContain(SECRET);
    expect(value).toContain(":::gate");
  });

  test("无编辑权限的人：编辑页返回 404，不暴露帖子存在性", async ({ page, context }) => {
    await loginAs(context, USERS.xiaoyi);
    const res = await page.goto(`/p/${GATED_FIRST}/edit`);
    expect(res?.status()).toBe(404);
    await expect(page.getByText(SECRET)).toHaveCount(0);
  });

  test("版主编辑他人的回帖：必须填理由，缺理由被拒，填写后保存成功", async ({ page, context }) => {
    await loginAs(context, USERS.admin);
    await page.goto(`/p/${REPLY}/edit`);
    await expect(page.locator("#edit-reason")).toBeVisible();

    await page.locator("#edit-source").fill(`版主改写 ${Date.now()}`);
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.locator('p[role="alert"]')).toHaveText(
      "版主编辑他人的内容须填写理由（会写入审计记录）。",
    );

    const text = `版主改后的内容 ${Date.now()}`;
    await page.locator("#edit-source").fill(text);
    await page.locator("#edit-reason").fill("E2E 清理");
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page).toHaveURL(new RegExp(`#p${REPLY}$`));
    await expect(page.getByText(text)).toBeVisible();
  });
});
