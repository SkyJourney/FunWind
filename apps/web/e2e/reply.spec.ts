import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";
import { bodyEditor, fillBody } from "./support/editor";

/**
 * 快速回复 E2E（M6.2 第 3 步，桌面）。
 * 主题直接用 SQL 造在 954（公开、不审核）、锁定主题在 954、归档主题在 955（已归档）。
 * 回复统一由 alice 发出：她不在其它发帖用例里出现，避开每账号的发帖间隔（会员 5 秒）。
 * 用例之间用时间戳区分正文，重复运行也成立（每次运行前 DB 已重建）。
 */

const OPEN = 960001; // 954 下，普通主题
const LOCKED = 960002; // 954 下，已锁定
const ARCHIVED = 960003; // 955（已归档）下

async function addThread(tid: number, forumId: number, title: string, locked: boolean) {
  const post = tid + 100;
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM posts WHERE thread_id = ?", [tid]);
    await q.exec("DELETE FROM threads WHERE id = ?", [tid]);
    await q.exec(
      `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, is_locked, created_at, last_posted_at)
       VALUES (?, ?, ?, ?, ?, 'visible', ?, '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
      [tid, forumId, USERS.xiaoyi, title, post, locked ? 1 : 0],
    );
    await q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
       VALUES (?, ?, 1, ?, '首帖正文', 0, 'visible', '2026-10-21 10:00:00')`,
      [post, tid, USERS.xiaoyi],
    );
  });
}

test.beforeAll(async () => {
  await addThread(OPEN, FIX.compose.id, "[E2E] 可回复的主题", false);
  await addThread(LOCKED, FIX.compose.id, "[E2E] 已锁定的主题", true);
  await addThread(ARCHIVED, FIX.archived.id, "[E2E] 归档区的主题", false);
});

test.describe("快速回复", () => {
  test("游客：主题页只提示登录，不渲染回复表单", async ({ page }) => {
    await page.goto(`/t/${OPEN}`);
    await expect(page.getByText("登录后可回复。")).toBeVisible();
    await expect(bodyEditor(page)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "去登录" })).toHaveAttribute("href", "/login");
  });

  test("会员：回复后跳到新回复所在的锚点，并看到正文", async ({ page, context }) => {
    await loginAs(context, USERS.alice);
    await page.goto(`/t/${OPEN}`);

    const body = `E2E 回复 ${Date.now()}`;
    await fillBody(page, body);
    await page.getByRole("button", { name: "发表回复" }).click();

    await expect(page).toHaveURL(new RegExp(`/t/${OPEN}(\\?page=\\d+)?#p\\d+$`));
    await expect(page.getByText(body)).toBeVisible();
  });

  test("失败回显与草稿恢复：正文超长被拒，错误文案出现，正文原样回到输入框", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.alice);
    await page.goto(`/t/${OPEN}`);

    // 超过 50000 字的上限：在提交前由 createReply 的正文校验拒绝，不占用发帖间隔
    const body = "x".repeat(50_001);
    await fillBody(page, body);
    await page.getByRole("button", { name: "发表回复" }).click();

    await expect(page.locator('p[role="alert"]')).toHaveText("正文太长了，请精简后再发。");
    await expect(bodyEditor(page)).toContainText(body);
    // URL 里只带固定错误码，不带正文
    await expect(page).toHaveURL(/reply=body_too_long#reply$/);
  });

  test("锁定的主题：说明锁定，不渲染回复表单", async ({ page, context }) => {
    await loginAs(context, USERS.alice);
    await page.goto(`/t/${LOCKED}`);
    await expect(page.getByText("主题已锁定，暂不接受回复。")).toBeVisible();
    await expect(bodyEditor(page)).toHaveCount(0);
  });

  test("归档版块的主题：说明归档，不渲染回复表单", async ({ page, context }) => {
    await loginAs(context, USERS.alice);
    await page.goto(`/t/${ARCHIVED}`);
    await expect(page.getByText("该版块已归档，暂不接受新内容。")).toBeVisible();
    await expect(bodyEditor(page)).toHaveCount(0);
  });

  test("草稿：留有未发送的草稿，再次进入时提示恢复；选择恢复后正文回到编辑器", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.alice);
    // 水合错误会被 React 静默地重渲染成功，用例本身看不出来：显式收集页面异常
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`/t/${OPEN}`);
    // 草稿键与页面一致：funwind:draft:<uid>:reply:<tid>（localStorage 是每个用例独立的上下文）
    const draft = `E2E 未发送的草稿 ${Date.now()}`;
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [`funwind:draft:${USERS.alice}:reply:${OPEN}`, draft],
    );
    await page.reload();

    await expect(page.getByRole("status")).toContainText("发现一份未发送的草稿。");
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(bodyEditor(page)).toContainText(draft);
    await expect(page.getByRole("status")).toHaveCount(0);
    expect(pageErrors.filter((m) => m.includes("Hydration"))).toEqual([]);
  });

  test("回帖成功后草稿不残留：再次进入不提示恢复（提交时已暂存，成功后主键为空）", async ({
    page,
    context,
  }) => {
    // 版主不受发帖间隔限制，避免与本文件里的会员用例互相挤占
    await loginAs(context, USERS.admin);
    await page.goto(`/t/${OPEN}`);
    const body = `E2E 成功后不残留 ${Date.now()}`;
    await fillBody(page, body);
    await page.getByRole("button", { name: "发表回复" }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${OPEN}(\\?page=\\d+)?#p\\d+$`));
    await expect(page.getByText(body)).toBeVisible();

    await page.goto(`/t/${OPEN}`);
    await expect(bodyEditor(page)).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
  });
});
