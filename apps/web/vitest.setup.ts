import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

// RTL 自动清理依赖测试框架 globals；Vitest 关闭 globals 时需显式调用
afterEach(() => cleanup());

// jsdom 未实现 matchMedia；next-themes / 响应式逻辑需要
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
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
