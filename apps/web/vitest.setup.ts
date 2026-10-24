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

// next-themes 持久化依赖 localStorage（jsdom 自带，但清理保证用例独立）
beforeEach(() => {
  if (!hasDom) return;
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
