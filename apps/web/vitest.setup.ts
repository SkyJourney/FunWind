import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

// DB 集成测试用 node 环境（@vitest-environment node），没有 window：以下浏览器垫片仅在 jsdom 下安装
const hasDom = typeof window !== "undefined";

// RTL 自动清理依赖测试框架 globals；Vitest 关闭 globals 时需显式调用
afterEach(() => {
  if (hasDom) cleanup();
});

// jsdom 未实现 matchMedia；next-themes / 响应式逻辑需要
if (hasDom)
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

// jsdom 未实现 scrollIntoView；Tiptap 在命令执行后会异步调用它，缺失时会以未捕获异常让整次运行失败（toolbar 测试偶发）
if (hasDom && !Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
// ProseMirror 在滚动到选区（scrollToSelection）时需要几何信息：jsdom 没有布局，返回空矩形即可（只为不抛异常）
if (hasDom) {
  if (!Element.prototype.getClientRects)
    Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
}

// next-themes 持久化依赖 localStorage（jsdom 自带，但清理保证用例独立）
beforeEach(() => {
  if (!hasDom) return;
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
