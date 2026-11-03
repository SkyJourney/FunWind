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

  it("已存在键原位覆盖，新键追加；默认键须由页面省略而非预留 undefined", () => {
    expect(
      buildAdminQuery("/admin/review", { forum: 7, kind: "reply" }, { tab: "removed", page: "" }),
    ).toBe("/admin/review?forum=7&kind=reply&tab=removed");
    expect(buildAdminQuery("/admin/review", { tab: "removed", forum: 7 }, { tab: "pending" })).toBe(
      "/admin/review?tab=pending&forum=7",
    );
  });

  it("删除旧筛项不残留空值；数字 page=1 省略，字符串 page=1 沿用原约定", () => {
    expect(buildAdminQuery("/admin/poll", { tab: "open", forum: 7 }, { tab: "", page: 1 })).toBe(
      "/admin/poll?forum=7",
    );
    expect(buildAdminQuery("/admin/poll", {}, { page: "1" })).toBe("/admin/poll?page=1");
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

  it.each([
    [undefined, 1, 1],
    ["", 1, 1],
    ["bad", 1, 1],
    ["NaN", 1, 1],
    ["0", 1, 1],
    ["-3", 1, -3],
    ["2.9", 1, 2.9],
    ["Infinity", 1, Infinity],
    ["-Infinity", 1, -Infinity],
    ["01", 1, 1],
    ["+1", 1, 1],
    ["1e2", 100, 100],
    ["0x10", 16, 16],
  ])("%s 的严格与旧列表策略互不混淆", (raw, strict, legacy) => {
    expect(parseAdminPage(raw)).toBe(strict);
    expect(parseAdminPage(raw, "number-or-one")).toBe(legacy);
    expect(parseAdminPage(raw, "number-or-one")).toBe(Number(raw ?? "1") || 1);
  });
});
