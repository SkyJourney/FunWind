import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";

/**
 * 门控收尾的 E2E（M6.5a，桌面）。使用演示种子里的门控夹具（主题 900004、门控帖 900104，作者 alice；
 * 会员已购买门控 a1）。改动数据库的用例都在 finally 中还原，保证其它用例看到的仍是种子状态。
 */

const DEMO_THREAD = 900004;
const DEMO_GATE_POST = 900104;

test.describe.configure({ mode: "serial" });

test("作者编辑门控帖：已有人解锁的门控显示改价提示（改价只影响之后的购买）", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.alice);
  await page.goto(`/p/${DEMO_GATE_POST}/edit`);
  await expect(page.getByRole("note")).toContainText(
    /门控 a1 已有 \d+ 人解锁：改价只影响之后的购买/,
  );
});

test("未回复的登录读者：回复门控的锁卡片有「去回复」，链接指向回复框", async ({
  page,
  context,
}) => {
  // 游客只看到「登录」提示，回复门控的文案只对已登录且未回复的读者显示
  await loginAs(context, USERS.xiaoyi);
  await page.goto(`/t/${DEMO_THREAD}`);
  await expect(page.getByRole("link", { name: "去回复" })).toHaveAttribute("href", "#reply");
});

test("已购买的会员：作者改过隐藏正文之后，门控上显示「内容更新于」", async ({ page, context }) => {
  await withE2eDb((q) =>
    q.exec("UPDATE post_gates SET content_updated_at = NOW() WHERE post_id = ?", [DEMO_GATE_POST]),
  );
  try {
    await loginAs(context, USERS.member);
    await page.goto(`/t/${DEMO_THREAD}`);
    await expect(page.getByText(/内容更新于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/).first()).toBeVisible();
  } finally {
    await withE2eDb((q) =>
      q.exec("UPDATE post_gates SET content_updated_at = NULL WHERE post_id = ?", [DEMO_GATE_POST]),
    );
  }
});
