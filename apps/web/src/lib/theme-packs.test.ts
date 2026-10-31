import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PACK, isPackValue, packLabel, THEME_PACKS } from "./theme-packs";

describe("THEME_PACKS", () => {
  it("default 包始终在册（CSS themes/default.css 与注册表一一对应）", () => {
    expect(THEME_PACKS.map((p) => p.id)).toContain("default");
  });

  it("qy2010 在册（themes/qy2010.css）且 id 全局唯一", () => {
    const ids = THEME_PACKS.map((p) => p.id);
    expect(ids).toContain("qy2010");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("自带 LOGO 字段为 null 或 public/logo 下真实存在的文件名（不带路径；防注册表悬空）", () => {
    for (const p of THEME_PACKS) {
      if (p.logo === null) continue;
      expect(p.logo).toMatch(/^[a-z0-9][a-z0-9-]*\.png$/);
      // vitest cwd = apps/web（与 next 运行时的 process.cwd() 同口径，lib/brand/logo-pool-fs 据此定位素材）
      expect(existsSync(join(process.cwd(), "public", "logo", p.logo))).toBe(true);
    }
    expect(THEME_PACKS.find((p) => p.id === "qy2010")?.logo).toBe("qy2010.png");
  });
});

describe("isPackValue", () => {
  it("识别合法包 id", () => {
    expect(isPackValue("default")).toBe(true);
    expect(isPackValue("qy2010")).toBe(true);
  });

  it("拒绝非法值", () => {
    expect(isPackValue("blue")).toBe(false);
    expect(isPackValue(null)).toBe(false);
    expect(isPackValue(undefined)).toBe(false);
    expect(isPackValue("")).toBe(false);
  });
});

describe("packLabel", () => {
  it("返回注册表中的中文标签", () => {
    expect(packLabel("default")).toBe("现代浅色");
    expect(packLabel("qy2010")).toBe("复刻·青翼2010");
  });

  it("未知 id 原样返回（不抛错）", () => {
    expect(packLabel("blue" as never)).toBe("blue");
  });
});

describe("DEFAULT_PACK", () => {
  it("兜底为 default 且在册", () => {
    expect(DEFAULT_PACK).toBe("default");
    expect(isPackValue(DEFAULT_PACK)).toBe(true);
  });
});
