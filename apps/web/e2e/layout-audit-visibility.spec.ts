import { readFile, unlink } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { LayoutAudit } from "./support/layout-audit";

/**
 * 布局审计脚本自身的回归（M11.6 Step 3c 发现）。
 *
 * 起因：全站语义令牌面板是折叠的 <details>。Chromium 对折叠内容不渲染、不可点、不进无障碍树，
 * 却仍按展开时的流式位置给它们算出盒子，那些盒子恰好落在后面真实按钮的位置上，
 * 审计脚本只看盒子尺寸，就报了「操作控件互相覆盖」。这是审计的误报，不是页面的布局缺陷。
 * 修复是把浏览器自己的 checkVisibility() 并进可见性判定；这里用受控的最小页面固定两个方向：
 * 折叠内容不计入，展开后真实的重叠 / 溢出 / 缺失仍然要报出来。
 *
 * 只依赖 setContent，不访问站点页面。
 */
test.use({ screenshot: "off", trace: "off", video: "off" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "production", "审计自检只需在一个项目里跑一遍");
});

type Probe = { findings: { kind: string; target: string }[]; buttons: string[] };

/** 在受控页面上跑一次真实的 LayoutAudit.capture，读回它写下的 JSON */
async function probe(
  page: Page,
  body: string,
  options: { required?: string[] } = {},
): Promise<Probe> {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.setContent(
    `<!doctype html><html lang="zh-CN"><body style="margin:8px">${body}</body></html>`,
  );
  const info = test.info();
  await new LayoutAudit(page, info).capture("probe", {
    roots: "body",
    buttons: "body button",
    required: options.required,
  });
  const auditFile = info.outputPath("layout-audit.json");
  const saved = JSON.parse(await readFile(auditFile, "utf8")) as {
    snapshots: { findings: Probe["findings"]; geometry: { buttons: { target: string }[] } }[];
  };
  // 这些探针页面故意造出重叠与溢出，读完立刻删掉：留在 test-results 里会被 `pnpm layout:summary`
  // 当成真实页面的审计结果，让汇总永远退出码 1
  await unlink(auditFile);
  const [snapshot] = saved.snapshots;
  return {
    findings: snapshot.findings.map(({ kind, target }) => ({ kind, target })),
    buttons: snapshot.geometry.buttons.map((button) => button.target),
  };
}

const CLOSED = "<details><summary>摘要</summary><div><button>里面</button></div></details>";
const OPEN = CLOSED.replace("<details>", "<details open>");

test("折叠的 <details> 里的按钮不计入，不会与后面真实的按钮误判为重叠", async ({ page }) => {
  const result = await probe(page, `${CLOSED}<button>外面</button>`);
  // 前提：折叠内容确实被算出了盒子，并且落在后面按钮的位置上。浏览器哪天不再这样，这条会提醒修复已无必要。
  const tops = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button")).map((b) => b.getBoundingClientRect().top),
  );
  expect(tops[0], "折叠内容的盒子与后面的按钮重合（误报的前提）").toBe(tops[1]);
  expect(result.findings).toEqual([]);
  expect(result.buttons).toEqual(["button 外面"]);
});

test("展开后按钮计入，且各占各的位置时没有问题", async ({ page }) => {
  const result = await probe(page, `${OPEN}<button>外面</button>`);
  expect(result.findings).toEqual([]);
  expect(result.buttons).toEqual(["button 里面", "button 外面"]);
});

test("展开的 <details> 里真实的重叠仍然会报出来（不能矫枉过正）", async ({ page }) => {
  const result = await probe(
    page,
    `<details open><summary>摘要</summary><div style="position:relative;height:40px">
       <button style="position:absolute;left:0;top:0">甲</button>
       <button style="position:absolute;left:10px;top:0">乙</button>
     </div></details>`,
  );
  expect(result.findings.map((finding) => finding.kind)).toEqual(["button-overlap"]);
});

test("外层折叠时，里面再嵌套的展开 <details> 也不计入", async ({ page }) => {
  const result = await probe(
    page,
    `<details><summary>外</summary><details open><summary>内</summary><button>深处</button></details></details><button>外面</button>`,
  );
  expect(result.findings).toEqual([]);
  expect(result.buttons).toEqual(["button 外面"]);
});

test("必要元素：在折叠内容里算缺失，展开后不缺；<summary> 本身一直可见", async ({ page }) => {
  const body = (open: boolean) =>
    `<details${open ? " open" : ""}><summary>摘要</summary><p id="inside">里面</p></details>`;
  const hidden = await probe(page, body(false), { required: ["#inside"] });
  expect(hidden.findings.map((finding) => finding.kind)).toEqual(["missing-required"]);
  const shown = await probe(page, body(true), { required: ["#inside"] });
  expect(shown.findings).toEqual([]);
  const summary = await probe(page, body(false), { required: ["summary"] });
  expect(summary.findings).toEqual([]);
});

test("折叠内容里的超宽元素不计入溢出；展开后照常报出", async ({ page }) => {
  const body = (open: boolean) =>
    `<details${open ? " open" : ""}><summary>摘要</summary><p style="width:2000px">宽</p></details>`;
  expect((await probe(page, body(false))).findings).toEqual([]);
  expect((await probe(page, body(true))).findings.length).toBeGreaterThan(0);
});
