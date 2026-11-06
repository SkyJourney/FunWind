import { BUILTIN_THEME_COLORS } from "@funwind/db";
import { describe, expect, it } from "vitest";
import {
  getThemeCatalog,
  invalidateThemeCatalog,
  isKnownPackId,
  refreshThemeCatalog,
  resolveEffectivePackValidated,
  type ThemeCatalogReadDb,
} from "./catalog";

/** 可注入的目录读取 fake：覆盖 DB 启用/停用、LOGO 资产引用、读库失败三条分支 */
const rows =
  (
    list: {
      id: string;
      name: string;
      enabled: boolean;
      isBuiltin?: boolean;
      assets?: unknown;
      definition?: unknown;
    }[],
  ): ThemeCatalogReadDb =>
  async () =>
    list;

describe("主题包目录（catalog，纯函数层）", () => {
  it("目录 = default 静态回退 ∪ DB 启用包；停用包不进目录；同名 DB 包覆盖静态包字段", async () => {
    const packs = await refreshThemeCatalog({
      readDb: rows([
        { id: "qy2010", name: "复刻·青翼2010", enabled: true, isBuiltin: true },
        { id: "xmas", name: "圣诞青翼", enabled: true },
        { id: "legacy", name: "旧包", enabled: false },
        { id: "default", name: "同名 default", enabled: true },
      ]),
    });
    const ids = packs.map((p) => p.id);
    expect(ids).toContain("default");
    expect(ids).toContain("qy2010");
    expect(ids).toContain("xmas");
    expect(ids).not.toContain("legacy");
    expect(ids.filter((id) => id === "default")).toHaveLength(1);
    expect(packs.find((p) => p.id === "default")?.source).toBe("static");
    expect(packs.find((p) => p.id === "qy2010")?.source).toBe("db");
    expect(packs.find((p) => p.id === "xmas")?.source).toBe("db");
  });

  it("将启用 DB definition/PWA 色值合并到静态内置包并提供自定义包渲染定义", async () => {
    const packs = await refreshThemeCatalog({
      readDb: rows([
        {
          id: "default",
          name: "后台改名默认",
          enabled: true,
          definition: {
            surfaces: { page: { light: { fill: { type: "solid", color: "#123456" } } } },
            pwa: { themeColor: "#112233", backgroundColor: "#f0f0f0" },
          },
        },
        {
          id: "custom-pk",
          name: "自定义包",
          enabled: true,
          definition: {
            surfaces: { page: { light: { fill: { type: "solid", color: "#abcdef" } } } },
            pwa: { themeColor: "#334455", backgroundColor: "#ffffff" },
          },
        },
      ]),
    });
    const builtin = packs.find((pack) => pack.id === "default");
    const custom = packs.find((pack) => pack.id === "custom-pk");
    expect(builtin).toMatchObject({
      source: "static",
      label: "后台改名默认",
      themeColor: "#112233",
      backgroundColor: "#f0f0f0",
      definition: { surfaces: { page: { light: { fill: { color: "#123456" } } } } },
    });
    expect(custom).toMatchObject({
      source: "db",
      themeColor: "#334455",
      backgroundColor: "#ffffff",
      definition: { surfaces: { page: { light: { fill: { color: "#abcdef" } } } } },
    });
  });

  it("停用内置 qy2010 后从可选目录移除，但系统 default 始终保留", async () => {
    const packs = await refreshThemeCatalog({
      readDb: rows([
        { id: "default", name: "现代浅色", enabled: true },
        { id: "qy2010", name: "复刻·青翼2010", enabled: false },
      ]),
    });
    expect(packs.map((pack) => pack.id)).toContain("default");
    expect(packs.map((pack) => pack.id)).not.toContain("qy2010");
  });

  it("数据包自带 LOGO：assets 内 kind=logo 的 poolFile 被识别；非法 assets 不炸", async () => {
    const packs = await refreshThemeCatalog({
      readDb: rows([
        {
          id: "xmas",
          name: "圣诞",
          enabled: true,
          assets: [{ kind: "logo", poolFile: "logo-xmas.png" }],
        },
        { id: "noassets", name: "无资源", enabled: true, assets: "not-an-array" },
      ]),
    });
    expect(packs.find((p) => p.id === "xmas")?.logo).toBe("logo-xmas.png");
    expect(packs.find((p) => p.id === "noassets")?.logo).toBeNull();
  });

  it("内置包的自带 LOGO：库里没有自己的 LOGO 资产时用登记表的文件名；有资产时以资产为准；不带 LOGO 的包为 null", async () => {
    // qy2010 现为 DB 包（Step 5b），需提供行才会出现在目录
    const seeded = await refreshThemeCatalog({
      readDb: rows([
        { id: "default", name: "现代浅色", enabled: true, assets: [], isBuiltin: true },
        { id: "qy2010", name: "复刻·青翼2010", enabled: true, assets: [], isBuiltin: true },
      ]),
    });
    expect(seeded.find((p) => p.id === "qy2010")?.logo).toBe("qy2010.png");
    expect(seeded.find((p) => p.id === "default")?.logo).toBeNull();

    // 站长给内置包绑了池里的 LOGO：以资产为准
    const bound = await refreshThemeCatalog({
      readDb: rows([
        {
          id: "qy2010",
          name: "复刻·青翼2010",
          enabled: true,
          isBuiltin: true,
          assets: [{ kind: "logo", poolFile: "logo-bound.png" }],
        },
      ]),
    });
    expect(bound.find((p) => p.id === "qy2010")?.logo).toBe("logo-bound.png");
  });

  it("目录顺序：default 在最前，其后内置包在自定义包之前，同类按 id 排序；与库返回顺序无关", async () => {
    const list = [
      { id: "zeta", name: "Z", enabled: true },
      { id: "qy2010", name: "复刻·青翼2010", enabled: true, isBuiltin: true },
      { id: "alpha", name: "A", enabled: true },
      { id: "aaa-builtin", name: "内置甲", enabled: true, isBuiltin: true },
      { id: "default", name: "现代浅色", enabled: true, isBuiltin: true },
    ];
    const expected = ["default", "aaa-builtin", "qy2010", "alpha", "zeta"];
    const forward = await refreshThemeCatalog({ readDb: rows(list) });
    expect(forward.map((p) => p.id)).toEqual(expected);
    const backward = await refreshThemeCatalog({ readDb: rows([...list].reverse()) });
    expect(backward.map((p) => p.id)).toEqual(expected);
  });

  it("目录排序不改动读取器返回的数组（同一个数组可被重复读取）", async () => {
    const list = [
      { id: "zeta", name: "Z", enabled: true },
      { id: "alpha", name: "A", enabled: true },
    ];
    await refreshThemeCatalog({ readDb: rows(list) });
    expect(list.map((r) => r.id)).toEqual(["zeta", "alpha"]);
  });

  it("系统 default 即使库里被标为停用也保留在目录里", async () => {
    const packs = await refreshThemeCatalog({
      readDb: rows([{ id: "default", name: "现代浅色", enabled: false, isBuiltin: true }]),
    });
    expect(packs.map((p) => p.id)).toEqual(["default"]);
  });

  describe("PWA 色值：定义里没有 pwa 时的回退", () => {
    it("先看这个包自己的内置色，没有再用 default 的", async () => {
      // 内置色表里 qy2010 与 default 必须不同，否则下面的断言分不出回退到了谁
      expect(BUILTIN_THEME_COLORS.qy2010).not.toEqual(BUILTIN_THEME_COLORS.default);
      const packs = await refreshThemeCatalog({
        readDb: rows([
          { id: "qy2010", name: "复刻·青翼2010", enabled: true, isBuiltin: true },
          { id: "custom-a", name: "自定义", enabled: true },
        ]),
      });
      expect(packs.find((p) => p.id === "qy2010")).toMatchObject(BUILTIN_THEME_COLORS.qy2010);
      expect(packs.find((p) => p.id === "custom-a")).toMatchObject(BUILTIN_THEME_COLORS.default);
    });

    it("定义损坏（解析失败）的内置包同样用自己的内置色", async () => {
      const packs = await refreshThemeCatalog({
        readDb: rows([
          {
            id: "qy2010",
            name: "复刻·青翼2010",
            enabled: true,
            isBuiltin: true,
            definition: { surfaces: "不是对象" },
          },
        ]),
      });
      const qy = packs.find((p) => p.id === "qy2010");
      expect(qy?.definition).toBeNull();
      expect(qy).toMatchObject(BUILTIN_THEME_COLORS.qy2010);
    });

    it("定义里有 pwa 时以定义为准，不看内置色表", async () => {
      const packs = await refreshThemeCatalog({
        readDb: rows([
          {
            id: "qy2010",
            name: "复刻·青翼2010",
            enabled: true,
            isBuiltin: true,
            definition: {
              surfaces: {},
              pwa: { themeColor: "#010203", backgroundColor: "#040506" },
            },
          },
        ]),
      });
      expect(packs.find((p) => p.id === "qy2010")).toMatchObject({
        themeColor: "#010203",
        backgroundColor: "#040506",
      });
    });

    it("包 id 与 Object 原型上的属性同名（constructor 合法）时不能取到原型属性", async () => {
      const packs = await refreshThemeCatalog({
        readDb: rows([{ id: "constructor", name: "撞名包", enabled: true }]),
      });
      const pack = packs.find((p) => p.id === "constructor");
      expect(pack).toMatchObject(BUILTIN_THEME_COLORS.default);
      expect(typeof pack?.themeColor).toBe("string");
    });
  });

  it("TTL 缓存：TTL 内直接返回缓存目录（不重读库）；失效后重读", async () => {
    let calls = 0;
    const readDb: ThemeCatalogReadDb = async () => {
      calls++;
      return [{ id: "xmas", name: "圣诞", enabled: true }];
    };
    let clock = 1_000_000;
    const now = () => clock;
    invalidateThemeCatalog();
    await getThemeCatalog({ readDb, now });
    expect(calls).toBe(1);
    await getThemeCatalog({ readDb, now });
    expect(calls).toBe(1); // TTL 内命中缓存
    clock += 31_000; // 超过 30s TTL
    await getThemeCatalog({ readDb, now });
    expect(calls).toBe(2);
  });

  it("读库失败：冷启动回静态回退包（default）并记日志；已有缓存时沿用上次目录", async () => {
    const failing: ThemeCatalogReadDb = async () => {
      throw new Error("db down");
    };
    const cold = await refreshThemeCatalog({ readDb: failing });
    expect(cold.map((p) => p.id)).toEqual(["default"]);

    // 已有缓存后读库失败 → 沿用上次目录（不空目录）
    await refreshThemeCatalog({
      readDb: rows([{ id: "xmas", name: "圣诞", enabled: true }]),
    });
    const cached = await getThemeCatalog({ readDb: failing });
    expect(cached.map((p) => p.id)).toContain("xmas");
  });

  it("isKnownPackId：静态/启用 DB 包有效；停用与未知 id 无效", async () => {
    const readDb = rows([
      { id: "xmas", name: "圣诞", enabled: true },
      { id: "legacy", name: "旧包", enabled: false },
    ]);
    expect(await isKnownPackId("default", { readDb })).toBe(true);
    expect(await isKnownPackId("xmas", { readDb })).toBe(true);
    expect(await isKnownPackId("legacy", { readDb })).toBe(false);
    expect(await isKnownPackId("no-such", { readDb })).toBe(false);
  });

  it("回退链：用户偏好有效 → 站点默认有效 → default；无效项逐级跳过", async () => {
    const known = async (id: string) => id === "xmas" || id === "site-pk" || id === "default";
    expect(
      await resolveEffectivePackValidated(known, { userPref: "xmas", siteDefault: "site-pk" }),
    ).toBe("xmas");
    expect(
      await resolveEffectivePackValidated(known, { userPref: "stopped", siteDefault: "site-pk" }),
    ).toBe("site-pk");
    expect(await resolveEffectivePackValidated(known, { userPref: null, siteDefault: null })).toBe(
      "default",
    );
    expect(
      await resolveEffectivePackValidated(known, { userPref: "stopped", siteDefault: "stopped" }),
    ).toBe("default");
  });
});
