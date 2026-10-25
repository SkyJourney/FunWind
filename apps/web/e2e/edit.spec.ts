import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";
import { bodyEditor, fillBody } from "./support/editor";

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
    // M7-4：回帖挂一个下载附件（复用库内任一文件的 storage 行）
    await q.exec("DELETE FROM attachments WHERE post_id = ?", [REPLY]);
    await q.exec(
      `INSERT INTO attachments (post_id, file_id, uploader_id, original_name, kind, created_at)
       SELECT ?, file_id, ?, 'E2E 冲突附件.txt', 'download', '2026-10-21 10:01:00'
       FROM attachments WHERE kind = 'download' LIMIT 1`,
      [REPLY, USERS.alice],
    );
  });
});

test.describe("编辑帖子", () => {
  test("作者：主题页出现编辑入口，保存后跳到该回帖并看到新内容", async ({ page, context }) => {
    await loginAs(context, USERS.alice);
    await page.goto(`/t/${THREAD}`);
    await expect(page.locator(`a[href="/p/${REPLY}/edit"]`)).toBeVisible();

    await page.goto(`/p/${REPLY}/edit`);
    await expect(bodyEditor(page)).toContainText("回帖原文");
    const text = `E2E 改后的回帖 ${Date.now()}`;
    await fillBody(page, text);
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
    await fillBody(a, winner);
    await a.getByRole("button", { name: "保存修改" }).click();
    await expect(a).toHaveURL(new RegExp(`#p${REPLY}$`));

    // 窗口 B 仍持有旧版本号：保存被拒，提示冲突，输入框是最新版本而不是 B 自己的草稿
    await fillBody(b, "窗口 B 的覆盖尝试");
    await b.getByRole("button", { name: "保存修改" }).click();
    await expect(b.locator('p[role="alert"]')).toHaveText(
      "这条内容刚刚被修改过，请刷新页面后再编辑。",
    );
    await expect(bodyEditor(b)).toContainText(winner);
    await b.close();
    await a.close();
  });

  test("门控帖：作者打开编辑页，正文是完整源码（含门控的隐藏正文）", async ({ page, context }) => {
    await loginAs(context, USERS.alice);
    await page.goto(`/p/${GATED_FIRST}/edit`);
    // 所见即所得：门控是可视块，隐藏正文在块内
    await expect(page.locator(".fw-gate")).toBeVisible();
    await expect(page.locator(".fw-gate")).toContainText(SECRET);
    // 源码模式：完整的门控语法（含隐藏正文），与服务端保存的源码一致
    await page.getByRole("button", { name: "切换到源码" }).click();
    const source = await page.locator(".cm-content").innerText();
    expect(source).toContain(SECRET);
    expect(source).toContain(":::gate");
  });

  test("往返不等价的旧帖：强制源码模式，并说明原因（不能切回所见即所得）", async ({
    page,
    context,
  }) => {
    // 原始 HTML 的旧帖：编辑器的往返会改变渲染结果，因此只能以源码编辑
    await withE2eDb((q) =>
      q.exec(
        `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
         VALUES (960304, ?, 3, ?, '旧帖正文<sup>[1]</sup>结束', 0, 'visible', '2026-10-21 10:02:00')`,
        [THREAD, USERS.alice],
      ),
    );
    await loginAs(context, USERS.alice);
    await page.goto("/p/960304/edit");
    await expect(page.getByRole("note")).toContainText("无法完整还原");
    await expect(page.getByRole("button", { name: "切换到所见即所得" })).toBeDisabled();
    await expect(page.locator(".cm-content")).toContainText("<sup>[1]</sup>");
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

    await fillBody(page, `版主改写 ${Date.now()}`);
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.locator('p[role="alert"]')).toHaveText(
      "版主编辑他人的内容须填写理由（会写入审计记录）。",
    );

    const text = `版主改后的内容 ${Date.now()}`;
    await fillBody(page, text);
    await page.locator("#edit-reason").fill("E2E 清理");
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page).toHaveURL(new RegExp(`#p${REPLY}$`));
    await expect(page.getByText(text)).toBeVisible();
  });

  test("附件冲突恢复（M7-4）：两窗口编辑，后提交者恢复附件修改后保存成功，列表与提交版本一致", async ({
    context,
  }) => {
    await loginAs(context, USERS.alice);
    const a = await context.newPage();
    const b = await context.newPage();
    await a.goto(`/p/${REPLY}/edit`);
    await b.goto(`/p/${REPLY}/edit`);
    await expect(b.getByRole("region", { name: "附件" })).toBeVisible();
    await expect(b.getByLabel("移除附件：E2E 冲突附件.txt")).toBeVisible();

    // 窗口 A 先保存（只改正文）→ 胜出
    const winner = `窗口 A 先保存 ${Date.now()}`;
    await fillBody(a, winner);
    await a.getByRole("button", { name: "保存修改" }).click();
    await expect(a).toHaveURL(new RegExp(`#p${REPLY}$`));

    // 窗口 B：移除附件 + 改正文 → 保存被拒（版本冲突）
    await b.getByLabel("移除附件：E2E 冲突附件.txt").click();
    const bText = `窗口 B 的正文 ${Date.now()}`;
    await fillBody(b, bText);
    await b.getByRole("button", { name: "保存修改" }).click();
    await expect(b.locator('p[role="alert"]')).toHaveText(
      "这条内容刚刚被修改过，请刷新页面后再编辑。",
    );
    // 恢复提交失败的那一版（草稿 + 附件列表）
    await b.getByRole("button", { name: "恢复草稿" }).click();
    await b.getByRole("button", { name: "恢复附件" }).click();
    await expect(b.getByLabel("移除附件：E2E 冲突附件.txt")).toHaveCount(0);

    // 保存成功：正文为 B 的版本，附件列表与提交版本一致（B 已移除 → 帖子上无附件）
    await b.getByRole("button", { name: "保存修改" }).click();
    await expect(b).toHaveURL(new RegExp(`#p${REPLY}$`));
    await expect(b.getByText(bText)).toBeVisible();
    await withE2eDb(async (q) => {
      const rows = await q.query<{ id: number }>("SELECT id FROM attachments WHERE post_id = ?", [
        REPLY,
      ]);
      expect(rows).toHaveLength(0);
    });
    await b.close();
    await a.close();
  });
});
