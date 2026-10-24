import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";

/**
 * 门控 E2E：锁卡片、真实点击购买、已购买标签、作者统计、版主可见、余额不足、免费解锁、回复可见。
 * 夹具：主题 900004（版块 901，作者 alice）首帖 900104 含两个门控——
 *   a1 / 9001：积分 10（demo_member 已购买）；a2 / 9002：回复可见。
 * 积分显示名为「青翼币」（迁移导入的站点设置）。余额：alice 150 / team 50 / member 100。
 * 用例会改库（购买扣款），所以 beforeAll 先把本 spec 涉及的状态复位——重复运行也成立。
 */

const THREAD = 900004;
const FIRST_POST = 900104;
const PAID_TEXT = "这里是需要 10 积分才能解锁的隐藏正文";
const REPLY_TEXT = "回复本帖后才能看到这段内容";
const HIGH_THREAD = 991001; // 高价门控（500）
const FREE_THREAD = 991002; // 免费门控（0）

const locked = (page: Page) => page.locator('[data-gate-state="locked"]');
const open = (page: Page) => page.locator('[data-gate-state="open"]');

async function addGatedThread(
  q: { exec: (s: string, p?: unknown[]) => Promise<unknown> },
  tid: number,
  price: number,
) {
  const post = tid + 100;
  await q.exec(
    `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, created_at, last_posted_at)
     VALUES (?, 901, ?, ?, ?, 'visible', '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
    [tid, USERS.alice, `[E2E] 门控 ${price} 币`, post],
  );
  await q.exec(
    `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
     VALUES (?, ?, 1, ?, ?, 1, 'visible', '2026-10-21 10:00:00')`,
    [post, tid, USERS.alice, '这是一个测试门控\n\n:::gate{key="g1"}\n:::'],
  );
  await q.exec(
    `INSERT INTO post_gates (id, post_id, gate_key, conditions, match_mode, hidden_md, created_at, updated_at)
     VALUES (?, ?, 'g1', ?, 'all', ?, '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
    [tid, post, JSON.stringify([{ type: "points", price }]), `隐藏内容-价格${price}`],
  );
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    // 复位：清掉上次运行留下的购买记录、台账、临时主题与回帖，余额回到夹具值
    await q.exec("DELETE FROM gate_unlocks WHERE user_id = ?", [USERS.team]);
    // 注意：占位符不能写在引号里（mysql2 不会替换字符串字面量中的 ?），所以用 CONCAT 拼接
    await q.exec("DELETE FROM point_ledger WHERE idempotency_key LIKE CONCAT('gate\\_%:%:', ?)", [
      USERS.team,
    ]);
    await q.exec(
      "UPDATE point_accounts SET balance = 50, lifetime_earned = 50, lifetime_spent = 0 WHERE user_id = ?",
      [USERS.team],
    );
    await q.exec(
      "UPDATE point_accounts SET balance = 150, lifetime_earned = 150, lifetime_spent = 0 WHERE user_id = ?",
      [USERS.alice],
    );
    await q.exec("UPDATE post_gates SET unlock_count = 1 WHERE id = 9001");
    await q.exec("DELETE FROM posts WHERE thread_id = ? AND floor > 1", [THREAD]);
    for (const tid of [HIGH_THREAD, FREE_THREAD]) {
      await q.exec("DELETE FROM gate_unlocks WHERE gate_id = ?", [tid]);
      await q.exec("DELETE FROM post_gates WHERE id = ?", [tid]);
      await q.exec("DELETE FROM posts WHERE thread_id = ?", [tid]);
      await q.exec("DELETE FROM threads WHERE id = ?", [tid]);
    }
    await addGatedThread(q, HIGH_THREAD, 500);
    await addGatedThread(q, FREE_THREAD, 0);
  });
});

const balanceOf = async (page: Page, uid: number) => {
  await page.goto(`/u/${uid}`);
  const text = await page
    .getByText(/青翼币 \d+/)
    .first()
    .innerText();
  return Number(text.match(/青翼币 (\d+)/)![1]);
};

test("游客：两个门控都是锁卡片，只给登录入口；页面里没有任何隐藏文本", async ({ page }) => {
  await page.goto(`/t/${THREAD}`);
  await expect(locked(page)).toHaveCount(2);
  await expect(open(page)).toHaveCount(0);
  await expect(locked(page).first().getByRole("link", { name: "登录" })).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain(PAID_TEXT);
  expect(html).not.toContain(REPLY_TEXT);
  expect(html).not.toContain("隐藏正文");
});

test("已购买的会员：付费门控开放并带「已购买」标签；回复门控仍锁定", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  await page.goto(`/t/${THREAD}`);
  await expect(open(page)).toHaveCount(1);
  await expect(open(page).getByText(/已购买 · 10 青翼币/)).toBeVisible();
  await expect(open(page).getByText(PAID_TEXT)).toBeVisible();
  await expect(locked(page)).toHaveCount(1);
  await expect(locked(page).getByText("回复本帖后可见")).toBeVisible();
  expect(await page.content()).not.toContain(REPLY_TEXT);
});

test("未购买的团队成员：锁卡片显示价格与余额；点击购买 → 已购买、内容出现、余额扣减、作者到账", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.team);
  expect(await balanceOf(page, USERS.team)).toBe(50);

  await page.goto(`/t/${THREAD}`);
  const paidCard = locked(page).filter({ hasText: "付费内容" });
  await expect(paidCard.getByText("付费内容 · 10 青翼币")).toBeVisible();
  await expect(paidCard.getByText("当前余额 50 青翼币")).toBeVisible();
  expect(await page.content()).not.toContain(PAID_TEXT);

  await paidCard.getByRole("button", { name: "10 青翼币 解锁" }).click();

  // 购买走 Server Action，回到原帖并带锚点；整页按新状态重渲染
  await expect(page).toHaveURL(new RegExp(`/t/${THREAD}#p${FIRST_POST}$`));
  await expect(open(page).getByText(/已购买 · 10 青翼币/)).toBeVisible();
  await expect(open(page).getByText(PAID_TEXT)).toBeVisible();

  expect(await balanceOf(page, USERS.team)).toBe(40);
  expect(await balanceOf(page, USERS.alice)).toBe(160);
});

test("刷新 / 再次访问不会重复扣费；已购买后不再出现购买按钮", async ({ page, context }) => {
  await loginAs(context, USERS.team);
  await page.goto(`/t/${THREAD}`);
  await page.reload();
  await expect(open(page).getByText(/已购买/)).toBeVisible();
  await expect(page.getByRole("button", { name: /解锁/ })).toHaveCount(0);
  expect(await balanceOf(page, USERS.team)).toBe(40);
});

test("作者：看到自己的付费内容、解锁人数与累计收益", async ({ page, context }) => {
  await loginAs(context, USERS.alice);
  await page.goto(`/t/${THREAD}`);
  // 夹具里 demo_member 的 10 + 本轮 team 的 10
  await expect(page.getByText("你的付费内容 · 2 人解锁 · 收益 20 青翼币")).toBeVisible();
  await expect(open(page).first().getByText(PAID_TEXT)).toBeVisible();
  // 作者本人没有购买按钮
  await expect(page.getByRole("button", { name: /解锁/ })).toHaveCount(0);
});

test("版主（admin）：全部开放并标注「管理员可见」", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  await page.goto(`/t/${THREAD}`);
  await expect(open(page)).toHaveCount(2);
  await expect(page.getByText("管理员可见")).toHaveCount(2);
  await expect(open(page).first().getByText(PAID_TEXT)).toBeVisible();
});

test("余额不足：按钮禁用并提示；没有任何方式拿到隐藏内容", async ({ page, context }) => {
  await loginAs(context, USERS.team); // 此时余额 40，门控价格 500
  await page.goto(`/t/${HIGH_THREAD}`);
  const card = locked(page);
  await expect(card.getByText("付费内容 · 500 青翼币")).toBeVisible();
  await expect(card.getByText("（余额不足）")).toBeVisible();
  await expect(card.getByRole("button", { name: "500 青翼币 解锁" })).toBeDisabled();
  expect(await page.content()).not.toContain("隐藏内容-价格500");
});

test("失败提示条：只认固定提示码，未知参数不会被回显", async ({ page, context }) => {
  await loginAs(context, USERS.team);
  // Next.js 自带的路由播报元素也带 role=alert，这里只看页面里的提示条 <p role="alert">
  const notice = page.locator('p[role="alert"]');
  await page.goto(`/t/${HIGH_THREAD}?gate=insufficient`);
  await expect(notice).toContainText("积分不足，无法解锁该内容。");
  await page.goto(`/t/${HIGH_THREAD}?gate=<script>alert(1)</script>`);
  await expect(notice).toHaveCount(0);
  expect(await page.content()).not.toContain("<script>alert(1)</script>");
  await page.goto(`/t/${HIGH_THREAD}?gate=__proto__`);
  await expect(notice).toHaveCount(0);
});

test("免费门控（价格 0）：需要点击解锁，解锁后余额与台账都不变", async ({ page, context }) => {
  await loginAs(context, USERS.team);
  const ledgerBefore = await withE2eDb(async (q) =>
    Number(
      (
        await q.query<{ n: number }>("SELECT COUNT(*) n FROM point_ledger WHERE user_id = ?", [
          USERS.team,
        ])
      )[0]!.n,
    ),
  );
  await page.goto(`/t/${FREE_THREAD}`);
  expect(await page.content()).not.toContain("隐藏内容-价格0"); // 即使免费，点击前也不自动放行
  await locked(page).getByRole("button", { name: "免费解锁" }).click();
  await expect(open(page).getByText(/已解锁/)).toBeVisible();
  await expect(open(page).getByText("隐藏内容-价格0")).toBeVisible();

  expect(await balanceOf(page, USERS.team)).toBe(40);
  const ledgerAfter = await withE2eDb(async (q) =>
    Number(
      (
        await q.query<{ n: number }>("SELECT COUNT(*) n FROM point_ledger WHERE user_id = ?", [
          USERS.team,
        ])
      )[0]!.n,
    ),
  );
  expect(ledgerAfter).toBe(ledgerBefore);
});

test("回复可见：待审核回帖不解锁，可见回帖才解锁", async ({ page, context }) => {
  await loginAs(context, USERS.team);
  await page.goto(`/t/${THREAD}`);
  await expect(locked(page).getByText("回复本帖后可见")).toBeVisible();

  await withE2eDb((q) =>
    q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, state, created_at)
       VALUES (992001, ?, 2, ?, '我来回复了', 'pending', '2026-10-21 12:00:00')`,
      [THREAD, USERS.team],
    ),
  );
  await page.reload();
  await expect(locked(page).getByText("回复本帖后可见")).toBeVisible(); // 待审核的不算
  expect(await page.content()).not.toContain(REPLY_TEXT);

  await withE2eDb((q) => q.exec("UPDATE posts SET state = 'visible' WHERE id = 992001"));
  await page.reload();
  await expect(page.getByText("已回复，内容已解锁")).toBeVisible();
  await expect(page.getByText(REPLY_TEXT)).toBeVisible();
});
