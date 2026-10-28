import { expect, test, type Page } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { PNG_1X1 } from "./support/images";
import { bodyEditor, fillSource } from "./support/editor";
import { withE2eDb } from "./support/db";
import { relaxPostInterval } from "./support/limits";
import { USERS, loginAs } from "./support/session";
import { failOnPageErrors } from "./support/page-errors";

/**
 * 编辑器内容的「增删改查」——落库之后的部分（M10.8，站长要求每个工具产生的内容都要验证增删改查）。
 * editor-crud.spec 验证的是编辑器里的增 / 改 / 删 / 读回；这里验证**持久化之后**：
 *   增  发布一个包含所有工具产出的帖子（标题、行内格式、链接、列表、引用、代码块、表格、分隔线、表情、图片、锁定内容）
 *   查  发布后的渲染（作者视角与访客视角：访客看不到锁定内容）；重新打开编辑页，内容完整读回、未编辑不改写原文
 *   改  在编辑页修改（标题文字、链接地址、代码语言、表格单元格、价格）→ 保存 → 渲染随之变化
 *   删  在编辑页删除（表格、分隔线、图片、表情、锁定内容）→ 保存 → 渲染里没有了，**库里的附件引用与锁定内容行也被清理**
 * 串行：后面的步骤依赖前面发布出的帖子。用管理员：图片会占上传额度（会员每天 20 次），管理员不限。
 */
test.describe.configure({ mode: "serial" });
failOnPageErrors();

const stamp = Date.now();
const TITLE = `增删改查 ${stamp}`;
let restoreLimits: () => Promise<void>;
let threadId = 0;
let postId = 0;

test.beforeAll(async () => {
  restoreLimits = await relaxPostInterval();
});
test.afterAll(async () => {
  await restoreLimits();
});

const SOURCE = [
  "## 章节标题",
  "",
  "正文 **粗体** *斜体* ~~删除线~~ `行内代码` [站点](https://example.com/a) 好👍",
  "",
  "- 无序一",
  "- 无序二",
  "",
  "1. 有序一",
  "2. 有序二",
  "",
  "> 引用内容",
  "",
  "```javascript",
  "const answer = 42;",
  "```",
  "",
  "| 甲 | 乙 |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "---",
  "",
  ':::gate{key="g1" unlock="points" price="10"}',
  "隐藏内容正文",
  ":::",
].join("\n");

const body = (page: Page) => page.locator(".content-md").first();
const hiddenSource = (page: Page) => page.locator('input[name="source"]').inputValue();
const gateRows = (pid: number) =>
  withE2eDb((q) => q.query<{ id: number }>("SELECT id FROM post_gates WHERE post_id = ?", [pid]));
const inlineRows = (pid: number) =>
  withE2eDb((q) =>
    q.query<{ id: number }>("SELECT id FROM attachments WHERE post_id = ? AND kind = 'inline'", [
      pid,
    ]),
  );

/** 点到某个元素本身并把光标放到行尾；等 ProseMirror 异步同步 DOM 选区（脚本紧跟的按键会在旧选区上生效，真人手速不会） */
async function caretAtEndOf(page: Page, selector: string, nth = 0) {
  await bodyEditor(page).locator(selector).nth(nth).click();
  await page.keyboard.press("End");
  await page.waitForTimeout(150);
}

async function openEdit(page: Page) {
  await page.goto(`/p/${postId}/edit`);
  await bodyEditor(page).waitFor();
  const discard = page.getByRole("button", { name: "丢弃" });
  if (await discard.isVisible()) await discard.click();
}
async function save(page: Page) {
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page).toHaveURL(new RegExp(`#p${postId}$`));
}

test("增：发布一个包含所有工具产出的帖子（含工具栏上传的图片）", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  await page.goto(`/f/${FIX.compose.id}/new`);
  await page.locator("#thread-title").fill(TITLE);
  await fillSource(page, SOURCE);
  // 切回所见即所得：证明编辑器能完整载入这些内容；然后用工具栏上传一张图
  await page.getByRole("button", { name: "切换到所见即所得" }).click();
  await bodyEditor(page).waitFor();
  await expect(bodyEditor(page).locator("table")).toBeVisible();
  await expect(bodyEditor(page).locator(".fw-gate")).toBeVisible();
  // 图片放在自己的段落里（用户的真实用法）：点到第一段行尾，回车另起一段再上传
  await bodyEditor(page).locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传图片", exact: true }).click();
  await (await chooser).setFiles({ name: "图.png", mimeType: "image/png", buffer: PNG_1X1 });
  await expect(page.getByTestId("inline-image-row")).toHaveCount(1);
  await page.getByRole("button", { name: "发布主题" }).click();
  await expect(page).toHaveURL(/\/t\/\d+$/);
  threadId = Number(page.url().match(/\/t\/(\d+)/)![1]);
  postId = await withE2eDb(async (q) => {
    const rows = await q.query<{ first_post_id: number }>(
      "SELECT first_post_id FROM threads WHERE id = ?",
      [threadId],
    );
    return rows[0]!.first_post_id;
  });
  expect(postId).toBeGreaterThan(0);
});

test("查：发布后的渲染——每个工具的产出都在（作者视角）", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  await page.goto(`/t/${threadId}`);
  const b = body(page);
  await expect(b.locator("h2")).toHaveText("章节标题");
  await expect(b.locator("strong")).toHaveText("粗体");
  await expect(b.locator("em")).toHaveText("斜体");
  await expect(b.locator("del")).toHaveText("删除线");
  await expect(b.locator("p code")).toHaveText("行内代码");
  await expect(b.locator('a[href="https://example.com/a"]')).toHaveText("站点");
  await expect(b).toContainText("👍");
  await expect(b.locator("ul > li")).toHaveText(["无序一", "无序二"]);
  await expect(b.locator("ol > li")).toHaveText(["有序一", "有序二"]);
  await expect(b.locator("blockquote")).toContainText("引用内容");
  await expect(b.locator("pre code.language-javascript .hljs-keyword")).toHaveText("const");
  await expect(b.locator("table th")).toHaveText(["甲", "乙"]);
  await expect(b.locator("table td")).toHaveText(["1", "2"]);
  await expect(b.locator("hr")).toHaveCount(1);
  await expect(b.locator('img[src^="/files/"]')).toHaveCount(1);
  // 锁定内容：作者看得到隐藏正文
  await expect(page.locator('[data-gate-state="open"]')).toContainText("隐藏内容正文");
  // 库：登记了 1 个锁定内容、1 条正文图片引用
  expect(await gateRows(postId)).toHaveLength(1);
  expect(await inlineRows(postId)).toHaveLength(1);
});

test("查：访客视角——锁定内容只显示锁卡片，隐藏正文不在页面里", async ({ browser }) => {
  const guest = await browser.newContext();
  const page = await guest.newPage();
  await page.goto(`/t/${threadId}`);
  await expect(page.locator('[data-gate-state="locked"]')).toBeVisible();
  await expect(page.getByText("隐藏内容正文")).toHaveCount(0);
  expect(await page.content()).not.toContain("隐藏内容正文");
  // 公开部分照常渲染
  await expect(body(page).locator("h2")).toHaveText("章节标题");
  await guest.close();
});

test("查：重新打开编辑页——内容完整读回，未编辑时提交的就是库里的原文", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await openEdit(page);
  const ed = bodyEditor(page);
  await expect(ed.locator("h2")).toHaveText("章节标题");
  await expect(ed.locator("strong")).toHaveText("粗体");
  await expect(ed.locator("table")).toBeVisible();
  await expect(ed.locator("hr")).toHaveCount(1);
  await expect(ed.locator(".fw-gate")).toBeVisible();
  await expect(ed.locator("img:not(.ProseMirror-separator)")).toHaveCount(1);
  await expect(page.getByTestId("inline-image-row")).toHaveCount(1);
  // 往返保护：没有编辑时，隐藏字段就是服务端给出的完整原文（含锁定内容的隐藏正文），不被编辑器改写
  const src = await hiddenSource(page);
  expect(src).toContain('key="g1"');
  expect(src).toContain("隐藏内容正文");
  expect(src).toContain("const answer = 42;");
});

test("改：在编辑页改标题文字、链接地址、代码语言、表格单元格、价格 → 保存 → 渲染随之变化", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await openEdit(page);
  const ed = bodyEditor(page);
  // 标题文字
  await caretAtEndOf(page, "h2");
  await page.keyboard.type("（改）");
  // 链接地址：光标在链接里按 ⌘/Ctrl+K，弹层预填的是原地址（证明光标确实在链接里），改成新地址
  await ed.locator("a").first().click(); // 只点链接文字本身（End 会跑到整行末尾，光标就出了链接）
  await page.waitForTimeout(150);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByLabel("链接地址")).toHaveValue("https://example.com/a");
  await page.getByLabel("链接地址").fill("https://b.cn/new");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("链接地址")).toHaveCount(0);
  // 代码语言
  await page.getByLabel("代码语言").selectOption("python");
  // 表格单元格
  await caretAtEndOf(page, "table td");
  await page.keyboard.type("9");
  // 价格
  await page.locator(".fw-gate-head").getByLabel("价格（积分）").fill("30");
  await page.locator(".fw-gate-head").getByLabel("价格（积分）").press("Tab");
  await save(page);
  const b = body(page);
  await expect(b.locator("h2")).toHaveText("章节标题（改）");
  await expect(b.locator('a[href="https://b.cn/new"]')).toHaveText("站点");
  await expect(b.locator("pre code")).toHaveClass(/language-python/);
  await expect(b.locator("table td").first()).toHaveText("19");
  // 价格：库里的条件
  const cond = await withE2eDb((q) =>
    q.query<{ conditions: unknown }>("SELECT conditions FROM post_gates WHERE post_id = ?", [
      postId,
    ]),
  );
  const raw = cond[0]!.conditions;
  expect(JSON.stringify(typeof raw === "string" ? JSON.parse(raw) : raw)).toContain('"price":30');
});

test("删：在编辑页删表格、分隔线、图片、表情、锁定内容 → 保存 → 渲染里没有，库里的引用与锁定内容行也清理了", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await openEdit(page);
  const ed = bodyEditor(page);
  // 表格：表格工具条的「删除整个表格」
  await ed.locator("table td").first().click();
  await page
    .getByRole("toolbar", { name: "表格工具" })
    .getByRole("button", { name: "删除整个表格" })
    .click();
  // 锁定内容：头部「删除」按钮
  await page.locator(".fw-gate-head").getByRole("button", { name: "删除锁定内容" }).click();
  // 图片：附件面板「移除」
  await page.getByRole("button", { name: "移除正文图片：图片 1" }).click();
  // 分隔线：点击它（原子节点被整体选中）再按退格
  await ed.locator("hr").first().click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Backspace");
  await expect(ed.locator("hr")).toHaveCount(0);
  // 表情：退格删掉 👍
  await ed.locator("p", { hasText: "好👍" }).first().click();
  await page.keyboard.press("End");
  await page.waitForTimeout(150);
  await page.keyboard.press("Backspace");
  await save(page);

  const b = body(page);
  await expect(b.locator("table")).toHaveCount(0);
  await expect(b.locator('img[src^="/files/"]')).toHaveCount(0);
  await expect(b).not.toContainText("👍");
  await expect(page.locator("[data-gate-state]")).toHaveCount(0);
  await expect(page.getByText("隐藏内容正文")).toHaveCount(0);
  // 其余内容保留
  await expect(b.locator("h2")).toHaveText("章节标题（改）");
  await expect(b.locator("strong")).toHaveText("粗体");
  await expect(b.locator("blockquote")).toContainText("引用内容");
  // 库：锁定内容行与正文图片引用都被清理
  expect(await gateRows(postId)).toHaveLength(0);
  expect(await inlineRows(postId)).toHaveLength(0);
  // 分隔线（若上面的键盘路径没删到，这里会暴露）
  await expect(b.locator("hr")).toHaveCount(0);
});
