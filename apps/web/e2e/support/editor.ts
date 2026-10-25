import { expect, type Locator, type Page } from "@playwright/test";

/**
 * 正文编辑器的 E2E 助手（M6.3）。两种模式的编辑区都是 role=textbox，无障碍名称是「正文」或「回复内容」：
 * - 所见即所得：ProseMirror（contenteditable）；
 * - 源码：CodeMirror 的 .cm-content（同样带 role=textbox）。
 * 门控块只能通过工具栏插入，或在源码模式里输入；所见即所得里手打的 `:::gate{…}` 只是普通文字，因此门控用例统一走源码。
 */
export function bodyEditor(page: Page): Locator {
  return page.getByRole("textbox", { name: /^(正文|回复内容)$/ });
}

/** 所见即所得模式下填写正文（整段替换） */
export async function fillBody(page: Page, text: string): Promise<void> {
  await bodyEditor(page).click();
  await bodyEditor(page).fill(text);
}

/** 切换到源码模式（若已在源码模式则不动），再整段替换为 text。门控语法必须经由这里输入 */
export async function fillSource(page: Page, text: string): Promise<void> {
  const toSource = page.getByRole("button", { name: "切换到源码" });
  if (await toSource.isVisible()) await toSource.click();
  const cm = page.locator(".cm-content");
  await expect(cm).toBeVisible();
  await cm.click();
  await cm.fill(text);
}
