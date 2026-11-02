// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));
import { errorHop, redirectWithError } from "./hop";

describe("错误跳转地址", () => {
  it("中文、emoji、换行与查询分隔符都编码，响应头仅含 ASCII", () => {
    const message = "密码错误😀\n请重试&x=1";
    const url = errorHop("/closure", message);
    expect(url).toMatch(/^[\x20-\x7e]+$/);
    expect(new URL(url, "https://example.com").searchParams.get("error")).toBe(message);
  });

  it("保留已有查询参数，跳转入口复用同一编码", () => {
    expect(errorHop("/closure?step=2", "错误")).toBe("/closure?step=2&error=%E9%94%99%E8%AF%AF");
    expect(() => redirectWithError("/closure", "错误")).toThrow(
      "REDIRECT:/closure?error=%E9%94%99%E8%AF%AF",
    );
  });
});
