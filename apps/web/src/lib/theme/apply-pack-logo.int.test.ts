// @vitest-environment node
import { eq } from "drizzle-orm";
import { getWebDb, siteSettings, themePackages } from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getLogoPoolRaw, registerLogo } from "@/lib/brand/logo-pool";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { invalidateThemeCatalog } from "@/lib/theme/catalog";
import { createThemePack } from "./packs";
import { applyThemePackLogo } from "./apply-pack-logo";

let tdb: TempDb;
const actor = { userId: 1, via: "admin" as const, ip: null };
const logoA = `logo-${"a".repeat(32)}.png`;
const logoB = `logo-${"b".repeat(32)}.png`;

beforeAll(async () => {
  tdb = await setupTempDb({ demo: false });
});

afterEach(async () => {
  await getWebDb().delete(themePackages).where(eq(themePackages.id, "logo-theme"));
  await getWebDb().delete(siteSettings).where(eq(siteSettings.key, "site.logo"));
  invalidateThemeCatalog();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("数据主题包 LOGO 联动", () => {
  it("无资源引用的自定义包不伪造静态 LOGO", async () => {
    await createThemePack({
      id: "logo-theme",
      name: "无 LOGO 主题",
      definition: { surfaces: {} },
      actor,
    });
    await expect(
      applyThemePackLogo("logo-theme", { ...actor, via: "theme" }),
    ).resolves.toMatchObject({ applied: false, reason: "unknown-pack" });
  });

  it("缺失素材安全不切换；资源池中存在时切到包引用 LOGO", async () => {
    await createThemePack({
      id: "logo-theme",
      name: "带 LOGO 主题",
      definition: { surfaces: {} },
      assets: [{ kind: "logo", poolFile: logoA }],
      actor,
    });
    const themeActor = { ...actor, via: "theme" as const };
    expect(await applyThemePackLogo("logo-theme", themeActor)).toMatchObject({
      applied: false,
      reason: "missing-asset",
    });

    await registerLogo("主题 LOGO", logoA, actor);
    await registerLogo("当前 LOGO", logoB, actor);
    expect((await getLogoPoolRaw()).active).toBe(logoB);
    expect(await applyThemePackLogo("logo-theme", themeActor)).toMatchObject({
      applied: true,
      imported: false,
      file: logoA,
    });
    expect((await getLogoPoolRaw()).active).toBe(logoA);
  });
});
