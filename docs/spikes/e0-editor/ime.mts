const { chromium } =
  await import("/Volumes/Projects/FunWind/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs");
const browser = await chromium.launch();
const SRC =
  '第一段文字\n\n:::gate{key="a1" unlock="points" price="10"}\n门控里的文字\n:::\n\n| 甲 | 乙 |\n| - | - |\n| 单元格 | x |\n\n> 引用里的文字\n\n- 列表项文字\n';
const scenarios: {
  name: string;
  focus: (page: any, sel: string) => Promise<void>;
  expect: (md: string) => boolean;
}[] = [
  {
    name: "普通段落末尾",
    focus: async (p, s) => {
      await p.locator(`${s} p`).first().click();
      await p.keyboard.press("End");
    },
    expect: (m) => /第一段文字字幕/.test(m),
  },
  {
    name: "普通段落中间",
    focus: async (p, s) => {
      await p.locator(`${s} p`).first().click();
      await p.keyboard.press("Home");
      await p.keyboard.press("ArrowRight");
    },
    expect: (m) => /第字幕一段文字/.test(m),
  },
  {
    name: "门控块内",
    focus: async (p, s) => {
      await p.locator(`.gate-content p`).first().click();
      await p.keyboard.press("End");
    },
    expect: (m) => /门控里的文字字幕/.test(m),
  },
  {
    name: "表格单元格内",
    focus: async (p, s) => {
      await p.locator(`${s} td`).first().click();
      await p.keyboard.press("End");
    },
    expect: (m) => /单元格字幕/.test(m),
  },
  {
    name: "引用内",
    focus: async (p, s) => {
      await p.locator(`${s} blockquote p`).first().click();
      await p.keyboard.press("End");
    },
    expect: (m) => /引用里的文字字幕/.test(m),
  },
  {
    name: "列表项内",
    focus: async (p, s) => {
      await p.locator(`${s} li p, ${s} li`).first().click();
      await p.keyboard.press("End");
    },
    expect: (m) => /列表项文字字幕/.test(m),
  },
];
for (const ed of ["milkdown", "tiptap"] as const) {
  console.log(`\n== ${ed}`);
  for (const sc of scenarios) {
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:5199/");
    await page.waitForFunction(() => (window as any).__spike);
    await page.evaluate(([e, m]) => (window as any).__spike.mountTest(e, m), [ed, SRC]);
    await page.waitForSelector("#test-host .ProseMirror");
    const cdp = await page.context().newCDPSession(page);
    await sc.focus(page, "#test-host .ProseMirror");
    // 模拟拼音组合：zi → zim → zimu（带下划线的预编辑）→ 上屏「字幕」
    for (const t of ["z", "zi", "zim", "zimu"]) {
      await cdp.send("Input.imeSetComposition", {
        text: t,
        selectionStart: t.length,
        selectionEnd: t.length,
      });
      await page.waitForTimeout(30);
    }
    await cdp.send("Input.insertText", { text: "字幕" });
    await page.waitForTimeout(150);
    const md: string = await page.evaluate(() => (window as any).__handle.getMarkdown());
    const raw = (md.match(/字幕/g) ?? []).length;
    const leftover = /zimu|zim\b/.test(md);
    const ok = sc.expect(md) && raw === 1 && !leftover;
    console.log(
      `  ${ok ? "✔" : "✘"} ${sc.name}${ok ? "" : `  （字幕出现 ${raw} 次，残留拼音 ${leftover}）`}`,
    );
    if (!ok) console.log("     markdown 片段:", JSON.stringify(md.slice(0, 160)));
    await page.close();
  }
}
await browser.close();
