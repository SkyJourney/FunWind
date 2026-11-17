import { describe, expect, it } from "vitest";
import { buildAdminQuery, densityCellClass, parseAdminListParams, parseAdminPage } from "./query";

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

describe("parseAdminListParams（M19 S3）", () => {
  it("size 走档位白名单：合法档透传，白名单外回落默认", () => {
    expect(parseAdminListParams({ size: "10" }).size).toBe(10);
    expect(parseAdminListParams({ size: "100" }).size).toBe(100);
    expect(parseAdminListParams({ size: "50" }).size).toBe(50);
    expect(parseAdminListParams({}).size).toBe(20);
    expect(parseAdminListParams({ size: undefined }).size).toBe(20);
    for (const bad of ["abc", "0", "-3", "2.9", "25", "999"]) {
      expect(parseAdminListParams({ size: bad }).size).toBe(20);
    }
    expect(parseAdminListParams({ size: "999" }, 50).size).toBe(50); // 自定义默认
  });

  it("density 只有 compact 与 cozy（默认），其余值一律回落 cozy", () => {
    expect(parseAdminListParams({ density: "compact" }).density).toBe("compact");
    expect(parseAdminListParams({}).density).toBe("cozy");
    for (const bad of ["cozy?", "COMPACT", "1", ""]) {
      expect(parseAdminListParams({ density: bad }).density).toBe("cozy");
    }
  });

  it("日期须完整合法且 from ≤ to；非法/倒置成对丢弃", () => {
    expect(parseAdminListParams({ from: "2026-01-02", to: "2026-01-31" })).toEqual({
      size: 20,
      density: "cozy",
      from: "2026-01-02",
      to: "2026-01-31",
    });
    expect(parseAdminListParams({ from: "2026-01-02" }).from).toBe("2026-01-02");
    expect(parseAdminListParams({ to: "2026-01-31" }).to).toBe("2026-01-31");
    expect(parseAdminListParams({ from: "2026-1-2" }).from).toBeUndefined();
    expect(parseAdminListParams({ to: "not-a-date" }).to).toBeUndefined();
    expect(parseAdminListParams({ from: "2026-02-01", to: "2026-01-31" }).from).toBeUndefined();
    expect(parseAdminListParams({ from: "2026-02-01", to: "2026-01-31" }).to).toBeUndefined();
    expect(parseAdminListParams({ from: "2026-01-31", to: "2026-01-31" }).from).toBe("2026-01-31");
  });

  it("densityCellClass：cozy 与原形态逐字一致，compact 收紧", () => {
    expect(densityCellClass("cozy")).toBe("px-3 py-1.5");
    expect(densityCellClass("compact")).toBe("px-2.5 py-1");
  });
});
