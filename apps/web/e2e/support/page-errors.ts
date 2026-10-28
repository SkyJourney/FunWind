import { expect, type Page, test } from "@playwright/test";

/**
 * 页面未捕获异常护栏：任何 `pageerror`（如 ProseMirror 的 `contentMatchAt on a node with invalid content`）都让当前用例失败。
 * 只检查「元素在不在」的用例，在编辑器已经坏掉（点击后不再响应）时也会是绿的——Step 7 的图片回归就是这样漏过去的。
 * 用法：在 spec 顶层调用一次 `failOnPageErrors()`。
 */
export function failOnPageErrors(): void {
  const errors = new WeakMap<Page, string[]>();
  test.beforeEach(({ page }) => {
    const list: string[] = [];
    errors.set(page, list);
    page.on("pageerror", (e) => list.push(e.message));
  });
  test.afterEach(({ page }) => {
    expect(errors.get(page) ?? [], "页面出现未捕获异常").toEqual([]);
  });
}
