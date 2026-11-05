// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { getWebDb, siteSettings, themePackages } from "@funwind/db";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import * as decor from "@/lib/brand/decor-pool";
import * as decorFs from "@/lib/brand/decor-pool-fs";
import * as logo from "@/lib/brand/logo-pool";
import * as logoFs from "@/lib/brand/logo-pool-fs";
import { invalidateThemeCatalog } from "@/lib/theme/catalog";
import * as packs from "@/lib/theme/packs";
import {
  buildThemePackArchive,
  parseThemePackArchive,
  type ThemePackArchiveAssetInput,
} from "@/lib/theme/theme-pack-archive";
import type { ThemePackDefinition } from "@/lib/theme/surface-schema";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { FULL_TOKENS } from "@/test/theme-token-fixture";
import { GET as exportPack } from "../[id]/export/route";
import { POST } from "./route";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/authz/require-admin", () => ({
  requireAdmin: vi.fn(async () => ({ userId: 1, ip: null })),
}));

const actor = { userId: 1, via: "admin" as const, ip: null };
const packId = "import-theme";
/** 往返用例里先建、再导出的源包 */
const SOURCE_ID = "export-source";
const oldDecor = `decor-${"e".repeat(32)}.png`;
const oldLogo = `logo-${"f".repeat(32)}.png`;
const decorA = `decor-${"a".repeat(32)}.png`;
const decorB = `decor-${"b".repeat(32)}.png`;
const logoA = `logo-${"a".repeat(32)}.png`;
const logoB = `logo-${"b".repeat(32)}.png`;
const pwa = { themeColor: "#123456", backgroundColor: "#f8f5e8" };
const image = (asset: string) => ({
  type: "image" as const,
  asset,
  position: "top left",
  size: "cover" as const,
  repeat: "no-repeat" as const,
  blend: "soft-light" as const,
  opacity: 0.7,
});
const definition: ThemePackDefinition = {
  pwa,
  tokens: FULL_TOKENS,
  surfaces: {
    "forum-band": { light: { fill: image(decorA) }, dark: { fill: image(decorB) } },
    "hero-image": {
      light: { contentSlot: { image: decorB, imageHeightPx: 240 } },
      dark: { contentSlot: { image: decorA, hideText: true } },
    },
  },
};

let tdb: TempDb;
let storage: string;
let assets: ThemePackArchiveAssetInput[];

function request(bytes: Uint8Array): Request {
  const form = new FormData();
  form.set("id", `  ${packId.toUpperCase()}  `);
  form.set("archive", new File([Buffer.from(bytes)], "theme.zip", { type: "application/zip" }));
  return new Request("http://127.0.0.1:3100/admin/themes/import", {
    method: "POST",
    headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" },
    body: form,
  });
}

function archive(): Uint8Array {
  return buildThemePackArchive({
    id: "source-theme",
    name: "导入测试主题",
    description: "补偿与 PWA 元数据回归",
    schemaVersion: 1,
    definition,
    assets,
  });
}

async function importBytes(bytes: Uint8Array): Promise<URLSearchParams> {
  const response = await POST(request(bytes));
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location")!, "http://127.0.0.1:3100");
  expect(location.pathname).toBe("/admin/themes");
  return location.searchParams;
}

const importPack = () => importBytes(archive());

function cleanupSpies() {
  return {
    removeDecor: vi.spyOn(decor, "removeDecor"),
    removeLogo: vi.spyOn(logo, "removeLogo"),
    restoreDecor: vi.spyOn(decor, "setActiveDecor"),
    restoreLogo: vi.spyOn(logo, "setActiveLogo"),
  };
}

function expectAllCompensations(spies: ReturnType<typeof cleanupSpies>) {
  expect(spies.removeDecor).toHaveBeenCalledTimes(2);
  expect(spies.removeLogo).toHaveBeenCalledTimes(2);
  expect(spies.restoreDecor).not.toHaveBeenCalled();
  expect(spies.restoreLogo).not.toHaveBeenCalled();
}

describe.skipIf(skipDb)("主题包导入（临时库 + 临时存储）", () => {
  beforeAll(async () => {
    tdb = await setupTempDb({ demo: false });
    storage = await mkdtemp(join(tmpdir(), "fw-theme-import-"));
    vi.stubEnv("STORAGE_DIR", storage);
    const png = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    assets = [
      { kind: "decor", poolFile: decorA, bytes: png },
      { kind: "logo", poolFile: logoA, bytes: png },
      { kind: "decor", poolFile: decorB, bytes: png },
      { kind: "logo", poolFile: logoB, bytes: png },
    ];
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await decor.decorPool.register("原装饰", oldDecor, actor);
    await logo.registerLogo("原 LOGO", oldLogo, actor);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await getWebDb().delete(themePackages).where(eq(themePackages.id, packId));
    await getWebDb().delete(themePackages).where(eq(themePackages.id, SOURCE_ID));
    await getWebDb()
      .delete(siteSettings)
      .where(inArray(siteSettings.key, ["site.decor", "site.logo"]));
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

  it("成功导入重映射明暗档与内容图，保留 PWA，全程不改变两个池的 active", async () => {
    const spies = cleanupSpies();
    const query = await importPack();
    expect(Object.fromEntries(query)).toEqual({ saved: "imported", id: packId });
    expect(spies.removeDecor).not.toHaveBeenCalled();
    expect(spies.removeLogo).not.toHaveBeenCalled();
    expect(spies.restoreDecor).not.toHaveBeenCalled();
    expect(spies.restoreLogo).not.toHaveBeenCalled();
    const pack = await packs.getThemePack(packId);
    expect(pack).not.toBeNull();
    const refs = packs.parseThemePackAssets(pack!.assets);
    const remappedDecor = refs.filter((asset) => asset.kind === "decor");
    expect(remappedDecor).toHaveLength(2);
    for (const asset of refs) {
      expect(asset.poolFile).not.toBe(decorA);
      expect(asset.poolFile).not.toBe(decorB);
      expect(asset.poolFile).not.toBe(logoA);
      expect(asset.poolFile).not.toBe(logoB);
    }
    const stored = pack!.definition as ThemePackDefinition;
    // 服务层会按随机文件名排序引用清单，按池的实际入池顺序校验来源映射。
    const importedDecor = (await decor.getDecorPoolRaw()).items.filter(
      (item) => item.file !== oldDecor,
    );
    expect(importedDecor).toHaveLength(2);
    const lightDecor = importedDecor[0].file;
    const darkDecor = importedDecor[1].file;
    expect(new Set(remappedDecor.map((asset) => asset.poolFile))).toEqual(
      new Set([lightDecor, darkDecor]),
    );
    expect(stored.pwa).toEqual(pwa);
    // 素材被重映射的同时，完整令牌（浅深两档）原样入库
    expect(stored.tokens).toEqual(FULL_TOKENS);
    expect(stored.surfaces["forum-band"].light.fill).toEqual(image(lightDecor));
    expect(stored.surfaces["forum-band"].dark?.fill).toEqual(image(darkDecor));
    expect(stored.surfaces["hero-image"].light.contentSlot).toEqual({
      image: darkDecor,
      imageHeightPx: 240,
    });
    expect(stored.surfaces["hero-image"].dark?.contentSlot).toEqual({
      image: lightDecor,
      hideText: true,
    });
    expect((await decor.getDecorPoolRaw()).active).toBe(oldDecor);
    expect((await logo.getLogoPoolRaw()).active).toBe(oldLogo);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/themes");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/decor");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/logo");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("导出再导入的往返：完整令牌、PWA 与区域定义经导出路由和导入路由后逐项相同", async () => {
    // 不带素材：素材的导出导入由上一个用例（导入）与 e2e（theme-manager.spec 的导出 ZIP 再导入）覆盖
    const source: ThemePackDefinition = {
      pwa,
      tokens: FULL_TOKENS,
      surfaces: { header: { light: { fill: { type: "solid", color: "#112233" } } } },
    };
    const created = await packs.createThemePack({
      id: SOURCE_ID,
      name: "往返源包",
      description: "导出再导入",
      definition: source,
      actor,
    });
    expect(created.ok).toBe(true);

    const response = await exportPack(
      new Request(`http://127.0.0.1:3100/admin/themes/${SOURCE_ID}/export`),
      { params: Promise.resolve({ id: SOURCE_ID }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const bytes = new Uint8Array(await response.arrayBuffer());
    // 导出这一半单独核对：归档里的定义已经带着完整令牌
    expect(parseThemePackArchive(bytes).definition.tokens).toEqual(FULL_TOKENS);

    expect(Object.fromEntries(await importBytes(bytes))).toEqual({
      saved: "imported",
      id: packId,
    });
    const imported = await packs.getThemePack(packId);
    expect(imported?.definition).toEqual(source);
    expect(imported).toMatchObject({ name: "往返源包", description: "导出再导入" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("create 返回 enabled-limit 仍清理所有新素材，保留原错误且补偿成功不加 warn", async () => {
    vi.spyOn(packs, "createThemePack").mockResolvedValueOnce({ ok: false, code: "enabled-limit" });
    const spies = cleanupSpies();
    expect(Object.fromEntries(await importPack())).toEqual({ err: "enabled-limit" });
    expectAllCompensations(spies);
    expect(await packs.getThemePack(packId)).toBeNull();
    expect(await decor.getDecorPoolRaw()).toEqual({
      items: [{ file: oldDecor, name: "原装饰" }],
      active: oldDecor,
    });
    expect(await logo.getLogoPoolRaw()).toEqual({
      items: [{ file: oldLogo, name: "原 LOGO" }],
      active: oldLogo,
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        packId,
        actorId: 1,
        stage: "create-pack",
        reason: "enabled-limit",
      }),
    );
  });

  it.each([
    ["removeDecor", "remove-decor", "decor"],
    ["removeLogo", "remove-logo", "logo"],
  ] as const)("%s 失败独立记录，继续后续补偿并保留 err + warn", async (method, stage, kind) => {
    vi.spyOn(packs, "createThemePack").mockResolvedValueOnce({ ok: false, code: "enabled-limit" });
    const spies = cleanupSpies();
    const error = new Error(`${stage}-failure`);
    spies[method].mockRejectedValueOnce(error);
    expect(Object.fromEntries(await importPack())).toEqual({
      err: "enabled-limit",
      warn: "import-cleanup",
    });
    expectAllCompensations(spies);
    expect(await packs.getThemePack(packId)).toBeNull();
    const file = spies[method].mock.calls[0][0];
    expect(console.error).toHaveBeenCalledWith(expect.any(String), {
      packId,
      actorId: 1,
      stage,
      asset: { kind, file },
      reason: error,
    });
    expect(console.error).toHaveBeenCalledTimes(2);
    if (kind === "decor") expect((await logo.getLogoPoolRaw()).active).toBe(oldLogo);
    else expect((await decor.getDecorPoolRaw()).active).toBe(oldDecor);
  });

  it("多项移除同时失败也逐项处理并记录，不提前终止或改变 active", async () => {
    vi.spyOn(packs, "createThemePack").mockResolvedValueOnce({ ok: false, code: "enabled-limit" });
    const spies = cleanupSpies();
    spies.removeDecor.mockRejectedValue(new Error("remove-decor"));
    spies.removeLogo.mockRejectedValue(new Error("remove-logo"));
    expect(Object.fromEntries(await importPack())).toEqual({
      err: "enabled-limit",
      warn: "import-cleanup",
    });
    expectAllCompensations(spies);
    expect(console.error).toHaveBeenCalledTimes(5);
    expect((await decor.getDecorPoolRaw()).items).toHaveLength(3);
    expect((await logo.getLogoPoolRaw()).items).toHaveLength(3);
    expect(await packs.getThemePack(packId)).toBeNull();
  });

  it("素材导入抛错记录素材来源与阶段，清理此前成功入池文件且保留 active", async () => {
    const originalAdd = logoFs.addLogo;
    const error = new Error("写入 LOGO 失败");
    vi.spyOn(logoFs, "addLogo").mockImplementationOnce(originalAdd).mockRejectedValueOnce(error);
    const spies = cleanupSpies();
    expect(Object.fromEntries(await importPack())).toEqual({ err: "asset-import" });
    expect(spies.removeDecor).toHaveBeenCalledTimes(2);
    expect(spies.removeLogo).toHaveBeenCalledTimes(1);
    expect((await decor.getDecorPoolRaw()).active).toBe(oldDecor);
    expect((await logo.getLogoPoolRaw()).active).toBe(oldLogo);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      packId,
      actorId: 1,
      stage: "import-logo",
      asset: { kind: "logo", file: logoB },
      reason: error,
    });
  });

  it("素材池校验失败保留具体原因，并继续补偿", async () => {
    vi.spyOn(decorFs, "addDecor").mockResolvedValueOnce({ ok: false, code: "bad_type" });
    expect(Object.fromEntries(await importPack())).toEqual({ err: "asset-import" });
    expect(await packs.getThemePack(packId)).toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      packId,
      actorId: 1,
      stage: "import-decor",
      asset: { kind: "decor", file: decorA },
      reason: expect.objectContaining({ message: "bad_type" }),
    });
  });

  it("创建抛错记录主体异常，仍清理全部新增素材并恢复当前项", async () => {
    const error = new Error("主题写入异常");
    vi.spyOn(packs, "createThemePack").mockRejectedValueOnce(error);
    const spies = cleanupSpies();
    expect(Object.fromEntries(await importPack())).toEqual({ err: "asset-import" });
    expectAllCompensations(spies);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      packId,
      actorId: 1,
      stage: "create-pack",
      asset: null,
      reason: error,
    });
  });

  it.each(["created", "rejected"] as const)(
    "导入结果 %s 也不会覆盖期间的并发 active 选择",
    async (outcome) => {
      const concurrentDecor = `decor-${"c".repeat(32)}.png`;
      const concurrentLogo = `logo-${"d".repeat(32)}.png`;
      const create = packs.createThemePack;
      vi.spyOn(packs, "createThemePack").mockImplementationOnce(async (input) => {
        await decor.decorPool.register("并发选装饰", concurrentDecor, actor);
        await logo.registerLogo("并发选 LOGO", concurrentLogo, actor);
        return outcome === "created" ? create(input) : { ok: false, code: "enabled-limit" };
      });
      const spies = cleanupSpies();
      const query = Object.fromEntries(await importPack());
      expect(query).toEqual(
        outcome === "created" ? { saved: "imported", id: packId } : { err: "enabled-limit" },
      );
      expect((await decor.getDecorPoolRaw()).active).toBe(concurrentDecor);
      expect((await logo.getLogoPoolRaw()).active).toBe(concurrentLogo);
      expect(spies.restoreDecor).not.toHaveBeenCalled();
      expect(spies.restoreLogo).not.toHaveBeenCalled();
      if (outcome === "created") {
        expect(spies.removeDecor).not.toHaveBeenCalled();
        expect(spies.removeLogo).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
      } else {
        expectAllCompensations(spies);
        expect((await decor.getDecorPoolRaw()).items).toHaveLength(2);
        expect((await logo.getLogoPoolRaw()).items).toHaveLength(2);
      }
    },
  );

  it("失败补偿时本次导入图片已被并发选为 active，保留选择并明确告警，不删除当前项", async () => {
    let selectedLogo: string | null = null;
    vi.spyOn(packs, "createThemePack").mockImplementationOnce(async () => {
      selectedLogo = (await logo.getLogoPoolRaw()).items.find(
        (item) => item.file !== oldLogo,
      )!.file;
      await logo.setActiveLogo(selectedLogo, actor);
      return { ok: false, code: "enabled-limit" };
    });
    expect(Object.fromEntries(await importPack())).toEqual({
      err: "enabled-limit",
      warn: "import-cleanup",
    });
    const pool = await logo.getLogoPoolRaw();
    expect(pool.active).toBe(selectedLogo);
    expect(pool.items).toContainEqual(expect.objectContaining({ file: selectedLogo }));
    expect(pool.items).toHaveLength(2);
    expect((await decor.getDecorPoolRaw()).active).toBe(oldDecor);
    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        stage: "remove-logo",
        reason: expect.objectContaining({ message: "active-asset-preserved" }),
      }),
    );
  });

  it("导入中的每次入池均保留 active，失败补偿前也没有临时激活主题图片", async () => {
    const addDecor = decorFs.addDecor;
    const addLogo = logoFs.addLogo;
    vi.spyOn(decorFs, "addDecor").mockImplementation(async (...args) => {
      const result = await addDecor(...args);
      expect((await decor.getDecorPoolRaw()).active).toBe(oldDecor);
      return result;
    });
    vi.spyOn(logoFs, "addLogo").mockImplementation(async (...args) => {
      const result = await addLogo(...args);
      expect((await logo.getLogoPoolRaw()).active).toBe(oldLogo);
      return result;
    });
    expect(Object.fromEntries(await importPack())).toEqual({ saved: "imported", id: packId });
  });

  it("导入前 active 为空时仍保持为空，不擅自激活主题素材", async () => {
    await decor.setActiveDecor(null, actor);
    await logo.setActiveLogo(null, actor);
    expect(Object.fromEntries(await importPack())).toEqual({ saved: "imported", id: packId });
    expect((await decor.getDecorPoolRaw()).active).toBeNull();
    expect((await logo.getLogoPoolRaw()).active).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });
});
