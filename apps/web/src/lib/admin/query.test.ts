import { describe, expect, it } from "vitest";
import { buildAdminQuery, parseAdminPage } from "./query";

describe("buildAdminQuery", () => {
  it("空值与 page=1 不进 URL；其余按序拼进", () => {
    expect(
      buildAdminQuery("/admin/mail", { status: "failed", kind: undefined, q: "", page: 1 }),
    ).toBe("/admin/mail?status=failed");
  });

  it("overrides 覆盖同名参数（翻页保留筛选）", () => {
    expect(
      buildAdminQuery("/admin/mail", { status: "failed", q: "sky", page: 1 }, { page: 3 }),
    ).toBe("/admin/mail?status=failed&q=sky&page=3");
  });

  it("全部为空时返回裸路径", () => {
    expect(buildAdminQuery("/admin/mail", { status: undefined, page: 1 })).toBe("/admin/mail");
  });

  it("值做 URI 编码（中文关键词）", () => {
    expect(buildAdminQuery("/admin/users", { q: "夜雨" })).toBe(
      "/admin/users?q=%E5%A4%9C%E9%9B%A8",
    );
  });
});

describe("parseAdminPage", () => {
  it("缺省 / 非整数 / 非正数回 1；正常页码透传", () => {
    expect(parseAdminPage(undefined)).toBe(1);
    expect(parseAdminPage("abc")).toBe(1);
    expect(parseAdminPage("0")).toBe(1);
    expect(parseAdminPage("-3")).toBe(1);
    expect(parseAdminPage("7")).toBe(7);
  });
});
