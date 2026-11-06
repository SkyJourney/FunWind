// @vitest-environment node
/**
 * 主题包目录集成测试（M11.1 Step 3）：静态注册表 ∪ DB 启用包的合并校验、TTL 缓存与失效、
 * 回退链（用户偏好 → 站点默认 → default；停用/未知 id 视为无效）。
 */
import { eq, sql } from "drizzle-orm";
import { getWebDb, siteSettings, themePackages } from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { invalidateThemeCatalog, isKnownPackId, refreshThemeCatalog } from "./catalog";

let tdb: TempDb;

beforeAll(async () => {
  tdb = await setupTempDb();
  // 演练数据包：启用 xmas + 停用 legacy（内置 static 包 default/qy2010 来自静态注册表）
  await getWebDb()
    .insert(themePackages)
    .values([
      {
        id: "xmas",
        name: "圣诞青翼",
        definition: { surfaces: {} },
        assets: [],
        enabled: true,
        isBuiltin: false,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      },
      {
        id: "legacy-pk",
        name: "已停用包",
        definition: { surfaces: {} },
        assets: [],
        enabled: false,
        isBuiltin: false,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      },
      {
        // id 按字母序排在 qy2010 之前：只有目录读取时带上 isBuiltin，内置包才会排在它前面
        id: "aaa-pk",
        name: "排序探针",
        definition: { surfaces: {} },
        assets: [],
        enabled: true,
        isBuiltin: false,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      },
    ]);
});

afterEach(async () => {
  invalidateThemeCatalog();
});

afterAll(async () => {
  await getWebDb().delete(themePackages).where(eq(themePackages.id, "xmas"));
  await getWebDb().delete(themePackages).where(eq(themePackages.id, "legacy-pk"));
  await getWebDb().delete(themePackages).where(eq(themePackages.id, "aaa-pk"));
  await tdb?.teardown();
});

describe.skipIf(skipDb)("主题包目录（catalog）", () => {
  it("目录 = default 静态回退 ∪ DB 启用包（含种子 qy2010）；停用包不进目录", async () => {
    const packs = await refreshThemeCatalog();
    const ids = packs.map((p) => p.id);
    expect(ids).toContain("default"); // 代码内置的回退包
    expect(ids).toContain("qy2010"); // 种子行（bootstrap 写入），不再有静态兜底
    expect(ids).toContain("xmas"); // DB 启用
    expect(ids).not.toContain("legacy-pk"); // DB 停用
    expect(packs.find((p) => p.id === "default")?.source).toBe("static");
    expect(packs.find((p) => p.id === "qy2010")).toMatchObject({
      source: "db",
      label: "复刻·青翼2010",
    });
    const xmas = packs.find((p) => p.id === "xmas");
    expect(xmas).toMatchObject({ source: "db", label: "圣诞青翼" });
  });

  it("真实库的目录顺序：default、内置包、自定义包（按 id）；内置包排在 id 更靠前的自定义包之前", async () => {
    const packs = await refreshThemeCatalog();
    const order = packs
      .map((p) => p.id)
      .filter((id) => ["default", "qy2010", "aaa-pk", "xmas"].includes(id));
    expect(order).toEqual(["default", "qy2010", "aaa-pk", "xmas"]);
  });

  it("isKnownPackId：静态/启用 DB 包有效；停用与未知 id 无效", async () => {
    expect(await isKnownPackId("default")).toBe(true);
    expect(await isKnownPackId("xmas")).toBe(true);
    expect(await isKnownPackId("legacy-pk")).toBe(false);
    expect(await isKnownPackId("no-such-pack")).toBe(false);
  });

  it("TTL 缓存：写入新包后旧目录仍可见（缓存内），失效后立即可见", async () => {
    await refreshThemeCatalog();
    await getWebDb()
      .insert(themePackages)
      .values({
        id: "spring",
        name: "新春",
        definition: { surfaces: {} },
        assets: [],
        enabled: true,
        isBuiltin: false,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      });
    // 缓存内：不失效看不到（30s TTL 盒语义）
    expect(await isKnownPackId("spring")).toBe(false);
    invalidateThemeCatalog();
    expect(await isKnownPackId("spring")).toBe(true);
    await getWebDb().delete(themePackages).where(eq(themePackages.id, "spring"));
    invalidateThemeCatalog();
  });

  it("停用已选包即回退：isKnownPackId 由 true 变 false（偏好读取侧据此落 default）", async () => {
    invalidateThemeCatalog();
    expect(await isKnownPackId("xmas")).toBe(true);
    await getWebDb()
      .update(themePackages)
      .set({ enabled: false })
      .where(eq(themePackages.id, "xmas"));
    invalidateThemeCatalog();
    expect(await isKnownPackId("xmas")).toBe(false);
    await getWebDb()
      .update(themePackages)
      .set({ enabled: true })
      .where(eq(themePackages.id, "xmas"));
    invalidateThemeCatalog();
    expect(await isKnownPackId("xmas")).toBe(true);
  });

  it("站点默认键（site.theme）指向停用包时，目录校验同样无效（回退链的站点级）", async () => {
    await getWebDb()
      .insert(siteSettings)
      .values({
        key: "site.theme",
        value: { pack: "xmas" },
        updatedAt: sql`NOW()`,
      });
    invalidateThemeCatalog();
    expect(await isKnownPackId("xmas")).toBe(true);
    await getWebDb().delete(siteSettings).where(eq(siteSettings.key, "site.theme"));
    invalidateThemeCatalog();
  });
});
