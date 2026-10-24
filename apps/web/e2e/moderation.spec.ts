import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";

/**
 * 删除 / 恢复 E2E（M6.2 第 5 步，桌面）。主题与帖子直接用 SQL 造在 954（公开、不审核）。
 * 作者 alice；回帖者 xiaoyi；版主 admin。每个用例用各自的主题，互不影响。
 */

const T_DEL = 960501; // 作者删自己的回帖
const T_HAS = 960502; // 主题已有他人回复：作者不能删主题
const T_MOD = 960503; // 版主删他人的回帖（需理由）
const T_REST = 960504; // 版主恢复一条已删除的回帖
const T_REJ = 960505; // 驳回后的回帖：编辑页显示驳回理由

// 帖子号段与主题号段分开：首帖 961001–961005，回帖 962001–962005（不靠主题号推导，避免撞号）
const FIRST_DEL = 961001;
const FIRST_HAS = 961002;
const FIRST_MOD = 961003;
const FIRST_REST = 961004;
const FIRST_REJ = 961005;

const OWN_REPLY = 962001; // alice 的回帖（作者删）
const HAS_REPLY = 962002; // xiaoyi 的回帖（让主题有他人回复）
const OTHER_REPLY = 962003; // xiaoyi 的回帖（版主删）
const DELETED_REPLY = 962004; // xiaoyi 的已删除回帖（版主恢复）
const REJECTED_REPLY = 962005; // alice 的被驳回回帖

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    const threads = [T_DEL, T_HAS, T_MOD, T_REST, T_REJ];
    for (const tid of threads) {
      await q.exec(
        "DELETE FROM content_reviews WHERE post_id IN (SELECT id FROM posts WHERE thread_id = ?)",
        [tid],
      );
      await q.exec("DELETE FROM posts WHERE thread_id = ?", [tid]);
      await q.exec("DELETE FROM threads WHERE id = ?", [tid]);
    }
    const make = async (tid: number, first: number, title: string, author: number) => {
      await q.exec(
        `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, created_at, last_posted_at)
         VALUES (?, ?, ?, ?, ?, 'visible', '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
        [tid, FIX.compose.id, author, title, first],
      );
      await q.exec(
        `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
         VALUES (?, ?, 1, ?, '首帖正文', 0, 'visible', '2026-10-21 10:00:00')`,
        [first, tid, author],
      );
    };
    const reply = async (id: number, tid: number, author: number, body: string, state: string) => {
      await q.exec(
        `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
         VALUES (?, ?, 2, ?, ?, 0, ?, '2026-10-21 10:01:00')`,
        [id, tid, author, body, state],
      );
    };
    await make(T_DEL, FIRST_DEL, "[E2E] 删回帖", USERS.alice);
    await reply(OWN_REPLY, T_DEL, USERS.alice, "待删除的回帖正文", "visible");

    await make(T_HAS, FIRST_HAS, "[E2E] 有他人回复", USERS.alice);
    await reply(HAS_REPLY, T_HAS, USERS.xiaoyi, "别人的回复", "visible");

    await make(T_MOD, FIRST_MOD, "[E2E] 版主删回帖", USERS.alice);
    await reply(OTHER_REPLY, T_MOD, USERS.xiaoyi, "版主要删的回帖正文", "visible");

    await make(T_REST, FIRST_REST, "[E2E] 版主恢复", USERS.alice);
    await reply(DELETED_REPLY, T_REST, USERS.xiaoyi, "被删后恢复的回帖正文", "deleted");

    await make(T_REJ, FIRST_REJ, "[E2E] 驳回后修改", USERS.alice);
    await reply(REJECTED_REPLY, T_REJ, USERS.alice, "被驳回的回帖正文", "rejected");
    await q.exec(
      `INSERT INTO content_reviews (id, post_id, reviewer_id, decision, note, created_at)
       VALUES (960701, ?, ?, 'rejected', '内容与版块主题无关', '2026-10-21 10:02:00')`,
      [REJECTED_REPLY, USERS.admin],
    );
  });
});

test.describe("删除与恢复", () => {
  test("作者：主题页出现删除入口；删除自己的回帖后，该回帖对作者消失", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.alice);
    await page.goto(`/t/${T_DEL}`);
    await expect(page.locator(`a[href="/p/${OWN_REPLY}/delete"]`)).toBeVisible();

    await page.goto(`/p/${OWN_REPLY}/delete`);
    await page.getByRole("button", { name: "确认删除回帖" }).click();

    await expect(page).toHaveURL(new RegExp(`/t/${T_DEL}$`));
    await expect(page.getByText("待删除的回帖正文")).toHaveCount(0);
  });

  test("主题已有他人回复：作者不能删除，说明原因且不渲染按钮", async ({ page, context }) => {
    await loginAs(context, USERS.alice);
    await page.goto(`/p/${FIRST_HAS}/delete`);
    await expect(
      page.getByText("主题已有其他人的回复，作者不能删除（可请版主处理）。"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /确认删除/ })).toHaveCount(0);
  });

  test("版主删除他人回帖：缺理由被拒，填写理由后删除成功", async ({ page, context }) => {
    await loginAs(context, USERS.admin);
    await page.goto(`/p/${OTHER_REPLY}/delete`);
    await expect(page.locator("#moderation-reason")).toBeVisible();

    await page.getByRole("button", { name: "确认删除回帖" }).click();
    await expect(page.locator('p[role="alert"]')).toHaveText(
      "版主编辑他人的内容须填写理由（会写入审计记录）。",
    );

    await page.locator("#moderation-reason").fill("E2E 广告");
    await page.getByRole("button", { name: "确认删除回帖" }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${T_MOD}$`));
    // 版主仍能看到已删除的回帖（带「已删除」标记）
    await expect(page.getByText("已删除", { exact: true }).first()).toBeVisible();
  });

  test("版主恢复：填写理由后回帖重新对所有人可见", async ({ page, context }) => {
    await loginAs(context, USERS.admin);
    await page.goto(`/t/${T_REST}`);
    await expect(page.locator(`a[href="/p/${DELETED_REPLY}/restore"]`)).toBeVisible();

    await page.goto(`/p/${DELETED_REPLY}/restore`);
    await page.locator("#moderation-reason").fill("E2E 误删");
    await page.getByRole("button", { name: "确认恢复回帖" }).click();

    await expect(page).toHaveURL(new RegExp(`/t/${T_REST}(\\?page=\\d+)?#p${DELETED_REPLY}$`));
    await expect(page.getByText("被删后恢复的回帖正文")).toBeVisible();
  });

  test("作者不能恢复自己删的内容：恢复页返回 404，主题页没有恢复入口", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.alice);
    const res = await page.goto(`/p/${DELETED_REPLY}/restore`);
    expect(res?.status()).toBe(404);
    await page.goto(`/t/${T_REST}`);
    await expect(page.locator(`a[href="/p/${DELETED_REPLY}/restore"]`)).toHaveCount(0);
  });

  test("驳回后的修改：编辑页显示驳回理由", async ({ page, context }) => {
    await loginAs(context, USERS.alice);
    await page.goto(`/p/${REJECTED_REPLY}/edit`);
    await expect(page.getByText("驳回理由：内容与版块主题无关")).toBeVisible();
  });
});
