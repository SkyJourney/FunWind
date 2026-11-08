import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_PACK_LOGOS, bundledLogoOf, DEFAULT_PACK, THEME_PACKS } from "./theme-packs";

describe("THEME_PACKS（静态注册表，M11.6 Step 5b）", () => {
  it("只保留 default 系统回退包（qy2010 等已移至 DB 种子）", () => {
    expect(THEME_PACKS).toHaveLength(1);
    expect(THEME_PACKS[0].id).toBe("default");
  });

  it("每个包的 id 唯一", () => {
    const ids = THEME_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("BUNDLED_PACK_LOGOS（随代码发布的 LOGO 登记）", () => {
  it("文件名是 public/logo 下真实存在的 PNG（不带路径；防登记表悬空）", () => {
    expect(BUNDLED_PACK_LOGOS.length).toBeGreaterThan(0); // 防止空表让下面的循环空转
    for (const entry of BUNDLED_PACK_LOGOS) {
      expect(entry.file).toMatch(/^[a-z0-9][a-z0-9-]*\.png$/);
      // vitest cwd = apps/web（与 next 运行时的 process.cwd() 同口径，lib/brand/logo-pool-fs 据此定位素材）
      expect(existsSync(join(process.cwd(), "public", "logo", entry.file))).toBe(true);
    }
  });

  it("id 唯一；qy2010 是历史来源标记（站长 2026-11-08 起该包不再内置，LOGO 素材仍随代码发布）", () => {
    const ids = BUNDLED_PACK_LOGOS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    // default 之外的历史登记项（qy2010）不要求是内置种子：applyPackLogo 的素材读取按此表定位
    // 文件，与主题包的内置性解耦；新增登记项须确认素材确需随代码发布。
    expect(ids).toContain("qy2010");
  });
});

describe("bundledLogoOf", () => {
  it("登记过的内置包返回文件名", () => {
    expect(bundledLogoOf("qy2010")).toBe("qy2010.png");
  });

  it("没登记的内置包、未知 id、空串返回 null", () => {
    expect(bundledLogoOf("default")).toBeNull();
    expect(bundledLogoOf("blue")).toBeNull();
    expect(bundledLogoOf("")).toBeNull();
  });

  it("只认完整的 id：复制出来的包（qy2010-copy-xxxx）、大小写不同、带空格的都不算登记项", () => {
    for (const id of ["qy2010-copy-ab12cd", "qy201", "QY2010", " qy2010", "qy2010 "]) {
      expect(bundledLogoOf(id), id).toBeNull();
    }
  });

  it("原型链上的键名不会被当成登记项", () => {
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(bundledLogoOf(key)).toBeNull();
    }
  });
});

describe("DEFAULT_PACK", () => {
  it("兜底为 default 且在静态注册表中", () => {
    expect(DEFAULT_PACK).toBe("default");
    expect(THEME_PACKS.some((p) => p.id === DEFAULT_PACK)).toBe(true);
  });
});
