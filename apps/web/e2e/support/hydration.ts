import { expect, type Locator } from "@playwright/test";

/**
 * 等元素水合完成。依赖客户端监听器的控件（如 `ConfirmSubmit` 的提交拦截）在水合之前点击，
 * 会绕过确认框、直接走原生表单提交。React 水合后会在 DOM 节点上挂 `__reactProps$…` 键，用它当信号。
 * 这是 React 内部实现细节，升级 React 后若信号消失，这里会超时报错，而不是悄悄放行。
 */
export async function hydrated(element: Locator): Promise<void> {
  await expect
    .poll(() =>
      element.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps$"))),
    )
    .toBe(true);
}
