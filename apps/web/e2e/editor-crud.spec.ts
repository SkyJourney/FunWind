import { expect, test, type Page } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { PNG_1X1 } from "./support/images";
import { bodyEditor } from "./support/editor";
import { USERS, loginAs } from "./support/session";
import { failOnPageErrors } from "./support/page-errors";

/**
 * 编辑器工具的「增删改查」矩阵（M10.8，站长要求：每个工具产生的内容都要把增删改查验证一遍，
 * 而不是只验证「能插进去」——锁定内容「删不掉」「能嵌套」就是只测了「增」漏掉的）。
 *
 *  增 = 用工具栏插入 → 隐藏字段（即将提交的 Markdown）出现预期语法
 *  查 = 读回：切源码再切回来 Markdown 不变（往返稳定）；预览与发布后的渲染见 editor-crud-publish.spec
 *  改 = 修改它的内容 / 属性（改级别、改链接地址、改语言、改单元格、改解锁方式……）
 *  删 = 去掉它（再点一次取消、专用删除入口、键盘删除）
 * 每个用例一个新编辑器，互不影响；全部在所见即所得模式下操作（真实选区、真实键盘）。
 */

failOnPageErrors();

const source = (page: Page) => page.locator('input[name="source"]').inputValue();
const tool = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

async function openEditor(
  page: Page,
  context: import("@playwright/test").BrowserContext,
  userId: number = USERS.member,
) {
  await loginAs(context, userId);
  await page.goto(`/f/${FIX.compose.id}/new`);
  await page.locator(".fw-rich-editor").waitFor();
  const discard = page.getByRole("button", { name: "丢弃" });
  if (await discard.isVisible()) await discard.click();
}
/**
 * 点到某个内容元素本身并把光标放到该行末尾。不要点编辑区中央：切换源码 / 所见即所得后编辑器会重建，光标回到文档开头；
 * 而点编辑区空白处会落进 TrailingNode 在末尾补的空段落里（光标跑到引用 / 列表外面）。
 */
async function caretAtEndOf(page: Page, selector: string, nth = 0) {
  // 同上：click 建立选区 + 原生 Selection collapse 到最后一个文本节点末尾
  await bodyEditor(page).locator(selector).nth(nth).click();
  await page.evaluate(
    ({ sel, n }) => {
      const el = document.querySelector(".fw-rich-editor")?.querySelectorAll(sel)[n];
      if (!el) return;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;
      while (walker.nextNode()) last = walker.currentNode as Text;
      if (last) {
        const range = document.createRange();
        range.setStart(last, last.data.length);
        range.collapse(true);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    },
    { sel: selector, n: nth },
  );
  // ProseMirror 异步同步 DOM 选区；脚本的下一次按键若紧跟着发出，会在旧选区上生效（真人手速不会）
  await page.waitForTimeout(120);
}

/** 输入一段文字并全选（后续工具作用在这段文字上） */
async function typeAndSelect(page: Page, text: string) {
  await bodyEditor(page).click();
  await page.keyboard.type(text);
  await page.keyboard.press("ControlOrMeta+A");
}
/** 查：切到源码再切回来，Markdown 必须逐字不变（往返稳定） */
async function expectRoundtripStable(page: Page) {
  const before = await source(page);
  await page.getByRole("button", { name: "切换到源码" }).click();
  await expect(page.locator(".cm-content")).toBeVisible();
  expect(await source(page)).toBe(before);
  await page.getByRole("button", { name: "切换到所见即所得" }).click();
  await expect(page.locator(".fw-rich-editor")).toBeVisible();
  expect(await source(page), "切换模式后 Markdown 变了（往返不稳定）").toBe(before);
}

test.describe("行内格式：加粗 / 斜体 / 删除线 / 行内代码", () => {
  const cases: [string, (t: string) => string][] = [
    ["加粗", (t) => `**${t}**`],
    ["斜体", (t) => `*${t}*`],
    ["删除线", (t) => `~~${t}~~`],
    ["行内代码", (t) => `\`${t}\``],
  ];
  for (const [name, wrap] of cases) {
    test(`${name}：增 → 查 → 改 → 删`, async ({ page, context }) => {
      await openEditor(page, context);
      await typeAndSelect(page, "文字");
      // 增
      await tool(page, name).click();
      await expect.poll(() => source(page)).toBe(wrap("文字"));
      await expect(tool(page, name)).toHaveAttribute("aria-pressed", "true");
      // 查
      await expectRoundtripStable(page);
      // 改：在格式内继续输入，仍在同一个格式里
      await caretAtEndOf(page, "p");
      await page.keyboard.type("续写");
      await expect.poll(() => source(page)).toBe(wrap("文字续写"));
      // 删：全选后再点一次 = 取消格式，文字保留
      await page.keyboard.press("ControlOrMeta+A");
      await tool(page, name).click();
      await expect.poll(() => source(page)).toMatch(/^文字续写\s*$/);
      await expect(tool(page, name)).toHaveAttribute("aria-pressed", "false");
    });
  }
});

test("标题：增 → 查 → 改 → 删", async ({ page, context }) => {
  await openEditor(page, context);
  await typeAndSelect(page, "章节");
  const pick = async (item: string) => {
    await tool(page, "标题").click();
    await page.getByRole("menuitem", { name: item }).click();
    // Radix 关闭菜单时用 setTimeout(0) 延后把焦点还给触发按钮；脚本紧接着再点触发按钮会让这次延后的聚焦关掉新菜单（真人间隔远大于此）
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.waitForTimeout(150);
  };
  await pick("标题 2");
  await expect.poll(() => source(page)).toMatch(/^## 章节\s*$/);
  await expectRoundtripStable(page);
  await caretAtEndOf(page, "h2"); // 标题是块级设置，折叠光标即可（选区若越过末尾补的空段落，会连它一起改）
  await pick("标题 3"); // 改
  await expect.poll(() => source(page)).toMatch(/^### 章节\s*$/);
  await pick("正文"); // 删
  await expect.poll(() => source(page)).toMatch(/^章节\s*$/);
});

test("链接：增 → 查 → 改 → 删", async ({ page, context }) => {
  await openEditor(page, context);
  await typeAndSelect(page, "站点");
  const setHref = async (url: string) => {
    await tool(page, "链接").click();
    const input = page.getByLabel("链接地址");
    await expect(input).toBeFocused();
    await input.fill(url);
    await page.keyboard.press("Enter");
    await expect(input).toHaveCount(0);
  };
  await setHref("example.com/a"); // 增（无协议自动补 https://）
  await expect.poll(() => source(page)).toMatch(/^\[站点\]\(https:\/\/example\.com\/a\)\s*$/);
  await expectRoundtripStable(page);
  // 改：光标在链接文字里重新打开，带出原地址，改成新地址
  await caretAtEndOf(page, "p");
  await page.keyboard.press("ControlOrMeta+A");
  await tool(page, "链接").click();
  await expect(page.getByLabel("链接地址")).toHaveValue("https://example.com/a");
  await page.getByLabel("链接地址").fill("https://b.cn/x");
  await page.keyboard.press("Enter");
  await expect.poll(() => source(page)).toMatch(/^\[站点\]\(https:\/\/b\.cn\/x\)\s*$/);
  // 删：「移除链接」去掉链接保留文字
  await page.keyboard.press("ControlOrMeta+A");
  await tool(page, "链接").click();
  await page.getByRole("button", { name: "移除链接" }).click();
  await expect.poll(() => source(page)).toMatch(/^站点\s*$/);
});

test.describe("块：列表 / 引用 / 代码块", () => {
  test("无序列表：增 → 查 → 改（换成有序）→ 删", async ({ page, context }) => {
    await openEditor(page, context);
    await typeAndSelect(page, "条目");
    await tool(page, "无序列表").click();
    await expect.poll(() => source(page)).toMatch(/^- 条目\s*$/);
    await expectRoundtripStable(page);
    await tool(page, "有序列表").click(); // 改
    await expect.poll(() => source(page)).toMatch(/^1\. 条目\s*$/);
    await tool(page, "有序列表").click(); // 删
    await expect.poll(() => source(page)).toMatch(/^条目\s*$/);
  });

  test("列表缩进：增 → 改（增加 / 减少缩进）→ 查", async ({ page, context }) => {
    await openEditor(page, context);
    await bodyEditor(page).click();
    await page.keyboard.type("一");
    await tool(page, "无序列表").click();
    await page.keyboard.press("Enter");
    await page.keyboard.type("二");
    await tool(page, "增加缩进").click(); // 改：二 变成一的子项
    await expect.poll(() => source(page)).toMatch(/- 一\n\s{2,}- 二/);
    await expectRoundtripStable(page);
    await caretAtEndOf(page, "li li"); // 切模式后光标回到开头：重新放到嵌套的第二项里
    await tool(page, "减少缩进").click(); // 改回
    await expect.poll(() => source(page)).toMatch(/- 一\n- 二/);
  });

  test("引用：增 → 查 → 改 → 删", async ({ page, context }) => {
    await openEditor(page, context);
    await typeAndSelect(page, "名言");
    await tool(page, "引用").click();
    await expect.poll(() => source(page)).toMatch(/^> 名言\s*$/);
    await expectRoundtripStable(page);
    await caretAtEndOf(page, "blockquote p");
    await page.keyboard.type("补充"); // 改
    await expect.poll(() => source(page)).toMatch(/^> 名言补充\s*$/);
    // 删：光标在引用里再点一次 = 取消引用。注意：若选区越过引用末尾、延伸进自动补的空段落，
    // 点引用走的是 Tiptap 标准的「整体包裹」分支（会再套一层），所以这里用折叠光标
    await caretAtEndOf(page, "blockquote p");
    await tool(page, "引用").click(); // 删
    await expect.poll(() => source(page)).toMatch(/^名言补充\s*$/);
  });

  test("代码块：增 → 查 → 改（语言）→ 删", async ({ page, context }) => {
    await openEditor(page, context);
    await typeAndSelect(page, "const a = 1;");
    await tool(page, "代码块").click();
    await expect.poll(() => source(page)).toMatch(/^```\nconst a = 1;\n```\s*$/);
    await expectRoundtripStable(page);
    await page.getByLabel("代码语言").selectOption("javascript"); // 改
    await expect.poll(() => source(page)).toMatch(/^```javascript\nconst a = 1;\n```\s*$/);
    await expect(bodyEditor(page).locator(".hljs-keyword")).toBeVisible();
    await page.getByLabel("代码语言").selectOption(""); // 改回纯文本
    await expect.poll(() => source(page)).toMatch(/^```\nconst a = 1;\n```\s*$/);
    // 删：只选代码这一行（全选会把末尾自动补的空段落也一起转成代码块）
    await caretAtEndOf(page, "pre code");
    await page.keyboard.press("Shift+Home");
    await tool(page, "代码块").click(); // 删
    await expect.poll(() => source(page)).toMatch(/^const a = 1;\s*$/);
  });
});

test("清除格式：对加粗 + 引用 + 链接一并去掉", async ({ page, context }) => {
  await openEditor(page, context);
  await typeAndSelect(page, "杂项");
  await tool(page, "加粗").click();
  await tool(page, "引用").click();
  await expect.poll(() => source(page)).toMatch(/^> \*\*杂项\*\*\s*$/);
  await tool(page, "清除格式").click();
  await expect.poll(() => source(page)).toMatch(/^杂项\s*$/);
});

test("表格：增 → 查 → 改（单元格 / 增行 / 增列）→ 删", async ({ page, context }) => {
  await openEditor(page, context);
  await tool(page, "插入表格").click();
  await expect.poll(() => source(page)).toMatch(/\|\s*-{3,}\s*\|/); // 增
  // 生产模式：表格插入后焦点可能还在工具栏按钮上（dev 的转场时序掩盖了这点），
  // 显式点回第一格再打字——否则字符全部丢失
  await bodyEditor(page).locator("th").first().click();
  await page.keyboard.type("甲"); // 改：写第一个表头单元格
  await expect.poll(() => source(page)).toContain("甲");
  await page.keyboard.press("Tab");
  await page.keyboard.type("乙");
  const bar = page.getByRole("toolbar", { name: "表格工具" });
  await bar.getByRole("button", { name: "在下方插入行" }).click(); // 改：增行
  await bar.getByRole("button", { name: "在右侧插入列" }).click(); // 改：增列
  const md = await source(page);
  expect(md.split("\n").filter((l) => l.startsWith("|")).length).toBe(5); // 表头 + 分隔 + 3 数据行
  expect(
    md
      .split("\n")
      .find((l) => l.startsWith("|"))!
      .split("|").length - 2,
  ).toBe(4); // 4 列
  await expectRoundtripStable(page); // 查
  await bar.getByRole("button", { name: "删除整个表格" }).click(); // 删
  await expect.poll(() => source(page)).not.toContain("|");
  await expect(page.getByRole("toolbar", { name: "表格工具" })).toHaveCount(0);
});

test("分隔线：增 → 查 → 删（键盘）", async ({ page, context }) => {
  await openEditor(page, context);
  await bodyEditor(page).click();
  await page.keyboard.type("上文");
  await tool(page, "分隔线").click(); // 增
  await expect.poll(() => source(page)).toMatch(/上文\s*\n+---/);
  await expectRoundtripStable(page); // 查
  // 删：光标在分隔线后面的空段落里，Backspace 先选中分隔线、再按一次删除（ProseMirror 的标准行为）
  await caretAtEndOf(page, "p"); // 切模式后文档末尾没有补的空段落：从「上文」行尾向下选中分隔线
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Backspace");
  await expect.poll(() => source(page)).not.toContain("---");
  expect(await source(page)).toContain("上文");
});

test("表情：增 → 查 → 改（换肤色）→ 删（退格整个字符）", async ({ page, context }) => {
  await openEditor(page, context);
  await bodyEditor(page).click();
  await page.keyboard.type("好");
  await tool(page, "表情").click();
  await page.getByLabel("搜索表情").fill("点赞");
  await page.getByRole("gridcell", { name: "赞" }).click(); // 增
  await expect.poll(() => source(page)).toBe("好👍");
  await expectRoundtripStable(page); // 查
  // 改：带肤色再插一个（切模式后光标回到开头，先放回行尾）
  await caretAtEndOf(page, "p");
  await tool(page, "表情").click();
  await page.getByRole("radio", { name: "中等肤色" }).click();
  await page.getByLabel("搜索表情").fill("点赞");
  await page.getByRole("gridcell", { name: "赞" }).click();
  await expect.poll(() => source(page)).toBe("好👍👍\u{1F3FD}");
  // 删：退格一次删掉带肤色的整个表情（不留下孤立的肤色方块），再退格删掉第一个
  await caretAtEndOf(page, "p");
  await page.keyboard.press("Backspace");
  await expect.poll(() => source(page)).toBe("好👍");
  await page.keyboard.press("Backspace");
  await expect.poll(() => source(page)).toBe("好");
});

test("图片：增 → 查（附件面板）→ 删（键盘 / 面板）", async ({ page, context }) => {
  // 用管理员：会员每天只有 20 次上传额度（uploadsPerDay），反复运行会耗尽；管理员的额度是 0 = 不限
  await openEditor(page, context, USERS.admin);
  await bodyEditor(page).click();
  await page.keyboard.type("图前");
  const chooser = page.waitForEvent("filechooser");
  await tool(page, "上传图片").click();
  await (await chooser).setFiles({ name: "图.png", mimeType: "image/png", buffer: PNG_1X1 });
  const img = bodyEditor(page).locator("img:not(.ProseMirror-separator)");
  await expect(img).toHaveCount(1); // 增
  await expect.poll(() => source(page)).toMatch(/!\[.*\]\(\/files\//);
  await expect(page.getByTestId("inline-image-row")).toHaveCount(1); // 查：面板派生
  await expectRoundtripStable(page);
  // 删（键盘）：切模式后光标回到开头。图片与「图前」同段（上传插在光标处=文字后），
  // DOM 为 <p>图前<img></p>——「p 的文本末尾」在图片【之前】，Backspace 删不到它。
  // 改为点击图片节点本身（NodeSelection），按 ArrowRight 把光标移到图片之后，再 Backspace 删图
  await bodyEditor(page).locator("img:not(.ProseMirror-separator)").click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Backspace");
  await expect(img).toHaveCount(0);
  await expect.poll(() => source(page)).not.toContain("/files/");
  await expect(page.getByTestId("inline-image-row")).toHaveCount(0);
  // 再传一张，用面板「移除」删（反向：面板 → 正文）
  const chooser2 = page.waitForEvent("filechooser");
  await tool(page, "上传图片").click();
  await (await chooser2).setFiles({ name: "图2.png", mimeType: "image/png", buffer: PNG_1X1 });
  await expect(page.getByTestId("inline-image-row")).toHaveCount(1);
  await page.getByRole("button", { name: "移除正文图片：图片 1" }).click();
  await expect(img).toHaveCount(0);
  await expect.poll(() => source(page)).not.toContain("/files/");
});

test("锁定内容：增 → 查 → 改（解锁方式 / 价格）→ 删（按钮 / 键盘）", async ({ page, context }) => {
  await openEditor(page, context);
  await bodyEditor(page).click();
  await page.keyboard.type("公开前言");
  await tool(page, "插入锁定内容").click(); // 增
  await page.keyboard.type("隐藏内容");
  await expect
    .poll(() => source(page))
    .toMatch(/:::gate\{key="g1" unlock="points" price="10"\}\n隐藏内容\n:::/);
  await expectRoundtripStable(page); // 查
  // 改：价格、解锁方式
  const head = page.locator(".fw-gate-head");
  await head.getByLabel("价格（积分）").fill("25");
  await head.getByLabel("价格（积分）").press("Tab");
  await expect.poll(() => source(page)).toContain('price="25"');
  await head.getByLabel("解锁方式").selectOption("reply");
  await expect.poll(() => source(page)).toMatch(/unlock="reply"\}/);
  expect(await source(page)).not.toContain("price=");
  // 删（按钮）：前言保留，隐藏内容随块一起删，撤销可找回。
  // 间隔 > 600ms：ProseMirror 历史会把 500ms 内、范围相邻的编辑合并成一个撤销组，脚本跑太快会连「插入锁定内容」一起撤掉
  await page.waitForTimeout(700);
  await head.getByRole("button", { name: "删除锁定内容" }).click();
  await expect.poll(() => source(page)).not.toContain(":::gate");
  expect(await source(page)).toContain("公开前言");
  await page.waitForTimeout(700);
  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(() => source(page)).toContain("隐藏内容");
  // 删（键盘）：把块内文字退格删光，再按一次 Backspace 删除整个空块
  await caretAtEndOf(page, ".fw-gate-content p");
  for (let i = 0; i < "隐藏内容".length; i++) await page.keyboard.press("Backspace");
  await expect.poll(() => source(page)).toContain(":::gate"); // 文字删光但块还在
  await page.keyboard.press("Backspace");
  await expect.poll(() => source(page)).not.toContain(":::gate");
  expect(await source(page)).toContain("公开前言");
});

test("预览（查）：标题 / 列表 / 引用 / 代码块高亮 / 表格 / 分隔线都按发布后的样子渲染，锁定内容只显示占位", async ({
  page,
  context,
}) => {
  await openEditor(page, context);
  await page.getByRole("button", { name: "切换到源码" }).click();
  await page.locator(".cm-content").click();
  await page
    .locator(".cm-content")
    .fill(
      [
        "## 预览标题",
        "",
        "- 甲",
        "- 乙",
        "",
        "> 引文",
        "",
        "```javascript",
        "const x = 1;",
        "```",
        "",
        "| 表头 |",
        "| --- |",
        "| 单元 |",
        "",
        "---",
        "",
        ':::gate{key="g1" unlock="reply"}',
        "秘密正文",
        ":::",
      ].join("\n"),
    );
  await page.getByRole("button", { name: "预览（近似，以发布后为准）" }).click();
  const preview = page.getByRole("region", { name: "预览" });
  await expect(preview.locator("h2")).toHaveText("预览标题");
  await expect(preview.locator("ul > li")).toHaveText(["甲", "乙"]);
  await expect(preview.locator("blockquote", { hasText: "引文" })).toHaveCount(1);
  await expect(preview.locator("pre code .hljs-keyword")).toHaveText("const");
  await expect(preview.locator("table th")).toHaveText("表头");
  await expect(preview.locator("hr")).toHaveCount(1);
  // 锁定内容：预览里只有占位，隐藏正文不出现
  await expect(preview.locator("blockquote", { hasText: "锁定内容" })).toHaveCount(1); // 占位说明用引用语法渲染
  await expect(preview).not.toContainText("秘密正文");
});
