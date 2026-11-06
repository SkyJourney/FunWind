// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getWebDb, siteSettings, themePackages } from "@funwind/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as logoPool from "@/lib/brand/logo-pool";
import * as logoFs from "@/lib/brand/logo-pool-fs";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { invalidateThemeCatalog } from "@/lib/theme/catalog";
import { BUNDLED_PACK_LOGOS } from "@/lib/theme-packs";
import * as packs from "./packs";
import { applyThemePackLogo, tryApplyThemePackLogo } from "./apply-pack-logo";

let tdb: TempDb;
let storage: string;
const actor = { userId: 1, via: "admin" as const, ip: null };
const themeActor = { ...actor, via: "theme" as const };
const logoA = `logo-${"a".repeat(32)}.png`;
const logoB = `logo-${"b".repeat(32)}.png`;
const packId = "logo-theme";

async function createPack(withLogo = true) {
  const result = await packs.createThemePack({
    id: packId,
    name: "LOGO 联动测试主题",
    definition: { surfaces: {} },
    ...(withLogo ? { assets: [{ kind: "logo", poolFile: logoA }] } : {}),
    actor,
  });
  expect(result.ok).toBe(true);
}

async function seedLogos(pack?: string) {
  await logoPool.registerLogo("主题 LOGO", logoA, actor, pack);
  await logoPool.registerLogo("当前 LOGO", logoB, actor);
}

describe.skipIf(skipDb)("数据主题包 LOGO 联动（临时库）", () => {
  beforeAll(async () => {
    tdb = await setupTempDb({ demo: false });
    // 内置包联动会把随代码发布的 LOGO 真实写进存储目录：指向临时目录，用后清理
    storage = await mkdtemp(join(tmpdir(), "fw-pack-logo-bundled-"));
    vi.stubEnv("STORAGE_DIR", storage);
  });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await getWebDb().delete(themePackages).where(eq(themePackages.id, packId));
    await getWebDb().delete(siteSettings).where(eq(siteSettings.key, "site.logo"));
    invalidateThemeCatalog();
  });

  afterAll(async () => {
    try {
      await tdb?.teardown();
    } finally {
      vi.unstubAllEnvs();
      if (storage) await rm(storage, { recursive: true, force: true });
    }
  });

  it("已有自定义包无 LOGO 返回 no-logo，包装为正常 unchanged，不触碰池或告警", async () => {
    await createPack(false);
    await logoPool.registerLogo("当前 LOGO", logoB, actor);
    const staticApply = vi.spyOn(logoFs, "applyPackLogo");
    const readPool = vi.spyOn(logoPool, "getLogoPoolRaw");
    const activate = vi.spyOn(logoPool, "setActiveLogo");
    expect(await applyThemePackLogo(packId, themeActor)).toEqual({
      applied: false,
      reason: "no-logo",
    });
    expect(await tryApplyThemePackLogo(packId, themeActor)).toEqual({
      status: "unchanged",
      reason: "no-logo",
    });
    expect(staticApply).not.toHaveBeenCalled();
    expect(readPool).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect((await logoPool.logoPool.getRaw()).active).toBe(logoB);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("没有自带 LOGO 的内置 default 同样正常 unchanged，无日志", async () => {
    expect(await tryApplyThemePackLogo("default", themeActor)).toEqual({
      status: "unchanged",
      reason: "no-logo",
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  // 逐个登记项走真实读取器：登记表与 logo-pool-fs 里的 readBundledPackLogo 不同步（登记了却没有读取分支、
  // 种子里没有这个包、文件名对不上）都会在这里变红；入池显示名取包当前的名称，不是登记表里的固定字样
  it.each([...BUNDLED_PACK_LOGOS])(
    "登记表里的 $id：库里没有自己的 LOGO 资产时，用随代码发布的素材入池，显示名取包当前名称",
    async ({ id, file }) => {
      const renamed = "站长改过的名字";
      const [original] = await getWebDb()
        .select({ name: themePackages.name })
        .from(themePackages)
        .where(eq(themePackages.id, id));
      try {
        await getWebDb()
          .update(themePackages)
          .set({ name: renamed })
          .where(eq(themePackages.id, id));
        expect(await tryApplyThemePackLogo(id, themeActor)).toMatchObject({
          status: "applied",
          imported: true,
        });
        const pool = await logoPool.getLogoPoolRaw();
        expect(pool.items).toHaveLength(1);
        expect(pool.items[0]).toMatchObject({ name: renamed, pack: id });
        expect(pool.active).toBe(pool.items[0]!.file);
        const bundled = await readFile(join(process.cwd(), "public", "logo", file));
        expect(Buffer.from((await logoFs.readLogoBytes())!)).toEqual(bundled);
        expect(console.error).not.toHaveBeenCalled();
      } finally {
        await getWebDb()
          .update(themePackages)
          .set({ name: original!.name })
          .where(eq(themePackages.id, id));
      }
    },
  );

  it("不存在的主题仍返回 unknown-pack，包装明确失败并记录原因", async () => {
    expect(await applyThemePackLogo("not-a-theme", themeActor)).toEqual({
      applied: false,
      reason: "unknown-pack",
    });
    expect(await tryApplyThemePackLogo("not-a-theme", themeActor)).toEqual({
      status: "failed",
      reason: "unknown-pack",
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      packId: "not-a-theme",
      actorId: 1,
      stage: "apply-bundled-logo",
      asset: null,
      reason: "unknown-pack",
    });
  });

  it("缺失资源安全不切换，包装返回 failed 并记录具体文件与操作者", async () => {
    await createPack();
    await logoPool.registerLogo("当前 LOGO", logoB, actor);
    expect(await applyThemePackLogo(packId, themeActor)).toEqual({
      applied: false,
      reason: "missing-asset",
    });
    expect(await tryApplyThemePackLogo(packId, themeActor)).toEqual({
      status: "failed",
      reason: "missing-asset",
    });
    expect((await logoPool.getLogoPoolRaw()).active).toBe(logoB);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      packId,
      actorId: 1,
      stage: "read-logo-pool",
      asset: logoA,
      reason: "missing-asset",
    });
  });

  it("资源存在且实际激活后才返回 applied，重复调用不导入也不告警", async () => {
    await createPack();
    await seedLogos();
    expect((await logoPool.getLogoPoolRaw()).active).toBe(logoB);
    expect(await applyThemePackLogo(packId, themeActor)).toEqual({
      applied: true,
      imported: false,
      file: logoA,
    });
    expect((await logoPool.getLogoPoolRaw()).active).toBe(logoA);
    expect(await tryApplyThemePackLogo(packId, themeActor)).toEqual({
      status: "applied",
      imported: false,
      file: logoA,
    });
    expect((await logoPool.getLogoPoolRaw()).items).toHaveLength(2);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("setActive 前目标被移除时识别静默未切换，不伪报 applied", async () => {
    await createPack();
    await seedLogos();
    const activate = logoPool.setActiveLogo;
    vi.spyOn(logoPool, "setActiveLogo").mockImplementation(async (file, changedBy) => {
      await logoPool.removeLogo(logoA, changedBy);
      await activate(file, changedBy);
    });
    expect(await applyThemePackLogo(packId, themeActor)).toEqual({
      applied: false,
      reason: "missing-asset",
    });
    await seedLogos();
    expect(await tryApplyThemePackLogo(packId, themeActor)).toEqual({
      status: "failed",
      reason: "missing-asset",
    });
    expect((await logoPool.getLogoPoolRaw()).active).toBe(logoB);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      packId,
      actorId: 1,
      stage: "verify-active-logo",
      asset: logoA,
      reason: "missing-asset",
    });
  });

  it("setActive 未抛错但 active 未命中目标，也不能宣称应用成功", async () => {
    await createPack();
    await seedLogos();
    vi.spyOn(logoPool, "setActiveLogo").mockResolvedValue(undefined);
    expect(await tryApplyThemePackLogo(packId, themeActor)).toEqual({
      status: "failed",
      reason: "missing-asset",
    });
    expect((await logoPool.getLogoPoolRaw()).active).toBe(logoB);
    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        stage: "verify-active-logo",
        asset: logoA,
        reason: "missing-asset",
      }),
    );
  });

  it("内置包复用池内标签 LOGO 也要验证实际激活", async () => {
    await seedLogos("qy2010");
    expect(await tryApplyThemePackLogo("qy2010", themeActor)).toEqual({
      status: "applied",
      imported: false,
      file: logoA,
    });
    await logoPool.setActiveLogo(logoB, actor);
    const activate = logoPool.setActiveLogo;
    vi.spyOn(logoPool, "setActiveLogo").mockImplementation(async (file, changedBy) => {
      await logoPool.removeLogo(logoA, changedBy);
      await activate(file, changedBy);
    });
    expect(await tryApplyThemePackLogo("qy2010", themeActor)).toEqual({
      status: "failed",
      reason: "missing-asset",
    });
    expect((await logoPool.getLogoPoolRaw()).active).toBe(logoB);
    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ packId: "qy2010", stage: "verify-active-logo", asset: logoA }),
    );
  });

  it.each(["bad_type", "too_large", "oversize", "missing-asset"] as const)(
    "内置联动返回 %s 同样记录失败，而不是正常无 LOGO",
    async (reason) => {
      vi.spyOn(logoFs, "applyPackLogo").mockResolvedValueOnce({ applied: false, reason });
      expect(await tryApplyThemePackLogo("qy2010", themeActor)).toEqual({
        status: "failed",
        reason,
      });
      expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
        packId: "qy2010",
        actorId: 1,
        stage: "apply-bundled-logo",
        asset: null,
        reason,
      });
    },
  );

  it.each(["read-pack", "read-logo-pool", "activate-logo", "verify-active-logo"] as const)(
    "%s 抛错被包装隔离并记录完整上下文，不向主题保存调用方抛出",
    async (stage) => {
      await createPack();
      await seedLogos();
      const error = new Error(`${stage} 异常`);
      if (stage === "read-pack") vi.spyOn(packs, "getThemePack").mockRejectedValueOnce(error);
      if (stage === "read-logo-pool") {
        vi.spyOn(logoPool, "getLogoPoolRaw").mockRejectedValueOnce(error);
      }
      if (stage === "activate-logo") {
        vi.spyOn(logoPool, "setActiveLogo").mockRejectedValueOnce(error);
      }
      if (stage === "verify-active-logo") {
        const readPool = logoPool.getLogoPoolRaw;
        vi.spyOn(logoPool, "getLogoPoolRaw")
          .mockImplementationOnce(readPool)
          .mockRejectedValueOnce(error);
      }
      expect(await tryApplyThemePackLogo(packId, themeActor)).toEqual({
        status: "failed",
        reason: "exception",
      });
      expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
        packId,
        actorId: 1,
        stage,
        asset: stage === "read-pack" ? null : logoA,
        reason: "exception",
        error,
      });
    },
  );

  it("内置联动抛错也只返回 failed，记录异常原由", async () => {
    const error = new Error("内置素材写入失败");
    vi.spyOn(logoFs, "applyPackLogo").mockRejectedValueOnce(error);
    expect(await tryApplyThemePackLogo("qy2010", { ...themeActor, userId: null })).toEqual({
      status: "failed",
      reason: "exception",
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      packId: "qy2010",
      actorId: null,
      stage: "apply-bundled-logo",
      asset: null,
      reason: "exception",
      error,
    });
  });
});
