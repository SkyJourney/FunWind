import { describe, expect, it } from "vitest";
import { evaluateContrast } from "@/lib/theme/contrast-advisor";
import { BASE_COLORS, effectiveColors } from "@/lib/theme/token-base";
import type { TokenSet } from "@/lib/theme/token-schema";
import { contrastRows, formatRatio } from "./contrast-rows";

const IDS = evaluateContrast(BASE_COLORS.light).map((check) => check.id);
const failing = (rows: ReturnType<typeof contrastRows>) =>
  rows.filter((row) => !row.pass).map((row) => row.id);
const notInherited = (rows: ReturnType<typeof contrastRows>) =>
  rows
    .filter((row) => !row.inherited)
    .map((row) => row.id)
    .sort();

describe("contrastRows：没有覆盖时就是默认主题", () => {
  it("18 行，id 与顺序同顾问", () => {
    expect(IDS).toHaveLength(18);
    for (const mode of ["light", "dark"] as const) {
      expect(contrastRows(mode, undefined).map((row) => row.id)).toEqual(IDS);
    }
  });

  it("每一行的比值与顾问对同一组颜色算出的一致", () => {
    const set: TokenSet = { colors: { primary: "#112233", background: "#fffdf4" } };
    expect(contrastRows("light", set).map((row) => row.ratio)).toEqual(
      evaluateContrast(effectiveColors("light", set.colors)).map((check) => check.ratio),
    );
  });

  it("默认浅色只有一项未达标（primary-tint-bg），默认深色全部达标", () => {
    expect(failing(contrastRows("light", undefined))).toEqual(["primary-tint-bg"]);
    expect(failing(contrastRows("dark", undefined))).toEqual([]);
  });

  it("没有覆盖：每一行都是继承的；undefined 与空集等价", () => {
    expect(contrastRows("light", undefined).every((row) => row.inherited)).toBe(true);
    expect(contrastRows("dark", {})).toEqual(contrastRows("dark", undefined));
  });

  it("前景、背景的中文名取自令牌编辑器里的颜色行名称", () => {
    const rows = Object.fromEntries(contrastRows("light", undefined).map((row) => [row.id, row]));
    expect([rows["fg-bg"].fgLabel, rows["fg-bg"].bgLabel]).toEqual(["正文", "页面底"]);
    expect([rows["primary-fg-primary"].fgLabel, rows["primary-fg-primary"].bgLabel]).toEqual([
      "主色上的文字",
      "主色",
    ]);
    expect([rows["muted-fg-card"].fgLabel, rows["muted-fg-card"].bgLabel]).toEqual([
      "弱化文字",
      "卡片底",
    ]);
    expect([rows["destructive-tint-bg"].fgLabel, rows["destructive-tint-bg"].bgLabel]).toEqual([
      "危险色",
      "页面底",
    ]);
  });
});

describe("contrastRows：覆盖影响的行", () => {
  it("覆盖正文：只有以正文为前景或背景的两行不再是继承的", () => {
    const rows = contrastRows("light", { colors: { foreground: "#f8fafc" } });
    expect(notInherited(rows)).toEqual(["fg-bg", "fg-card"]);
  });

  it("覆盖卡片底：七行（以卡片底为背景的）不再是继承的", () => {
    const rows = contrastRows("light", { colors: { card: "#fffdf4" } });
    expect(notInherited(rows)).toEqual(
      [
        "fg-card",
        "card-fg-card",
        "muted-fg-card",
        "primary-tint-card",
        "destructive-tint-card",
        "success-tint-card",
        "warning-tint-card",
      ].sort(),
    );
  });

  it("覆盖主色为黑：主色行不再是继承的，主按钮对比 21:1，默认主题自己那项缺口也消失了", () => {
    const rows = contrastRows("light", { colors: { primary: "#000000" } });
    expect(notInherited(rows)).toEqual(
      ["primary-fg-primary", "primary-tint-card", "primary-tint-bg"].sort(),
    );
    const button = rows.find((row) => row.id === "primary-fg-primary")!;
    expect(button.ratio).toBeCloseTo(21, 10);
    expect(button.pass).toBe(true);
    expect(failing(rows)).toEqual([]);
  });

  it("覆盖正文为页面底的颜色：对比度 1:1，未达标，且不是继承的", () => {
    const rows = contrastRows("light", { colors: { foreground: "#f8fafc" } });
    const row = rows.find((r) => r.id === "fg-bg")!;
    expect(row.ratio).toBeCloseTo(1, 10);
    expect([row.pass, row.inherited]).toEqual([false, false]);
    expect(failing(rows)).toEqual(["fg-bg", "fg-card", "primary-tint-bg"]);
  });

  it("覆盖成与基础层相同的值，仍算本包动过的键", () => {
    const rows = contrastRows("light", { colors: { foreground: BASE_COLORS.light.foreground } });
    expect(notInherited(rows)).toEqual(["fg-bg", "fg-card"]);
  });

  it("不合法的覆盖被忽略，与没覆盖一样（结果与继承标记都一致）", () => {
    const bad = { colors: { primary: "红", foreground: "#12" } } as unknown as TokenSet;
    expect(contrastRows("light", bad)).toEqual(contrastRows("light", undefined));
  });

  it("按档计算：同一个覆盖，浅色档与深色档各用各的基础层", () => {
    const set: TokenSet = { colors: { background: "#ffffff" } };
    const light = contrastRows("light", set).find((row) => row.id === "fg-bg")!;
    const dark = contrastRows("dark", set).find((row) => row.id === "fg-bg")!;
    expect(light.pass).toBe(true); // 浅色档的正文 #0f172a 压在白底上，对比度很高
    expect(dark.pass).toBe(false); // 深色档的正文 #f1f5f9 压在白底上，几乎看不见
    expect(dark.inherited).toBe(false);
  });

  it("不改入参", () => {
    const set: TokenSet = { colors: { primary: "#112233" } };
    const before = structuredClone(set);
    contrastRows("dark", set);
    expect(set).toEqual(before);
  });
});

describe("formatRatio：向下取整到两位小数", () => {
  it.each([
    [4.5, "4.50"],
    [21, "21.00"],
    [1, "1.00"],
    [4.487, "4.48"],
    [4.4996, "4.49"], // 四舍五入会得到 4.50，看上去达标，其实判的是未达标
    [4.509, "4.50"],
    [4.499999, "4.49"], // 差 0.000001 也是未达标，容差不能大到把它吞进 4.50
    [4.55, "4.55"], // 4.55 * 100 = 454.99999999999994
    [1.15, "1.15"], // 1.15 * 100 = 114.99999999999999
    [8.2, "8.20"], // 8.2 * 100 = 819.9999999999999
  ])("%d → %s", (ratio, expected) => {
    expect(formatRatio(ratio)).toBe(expected);
  });
});
