// @vitest-environment node
/**
 * Hero 横幅池集成测试（M11 插槽 ⑤）：brand-pool 泛化后的 hero 实例——
 * add 的魔数/字节/像素上限、入池即当前、setActive/remove 语义、readBytes 池内校验、审计动作名与 targetType。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, getWebDb } from "@funwind/db";
import { eq } from "drizzle-orm";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { addHero, HERO_MAX_BYTES, readHeroBytes } from "./hero-pool-fs";
import { getHeroPoolRaw, removeHero, setActiveHero } from "./hero-pool";
import { getLogoPoolRaw } from "./logo-pool";

let tdb: TempDb | undefined;
let dir: string | undefined;
const previousStorageDir = process.env.STORAGE_DIR;

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#336699" } })
    .png()
    .toBuffer();

beforeAll(async () => {
  tdb = await setupTempDb({ demo: false });
  dir = mkdtempSync(join(tmpdir(), "fw-hero-"));
  process.env.STORAGE_DIR = dir;
});

afterAll(async () => {
  try {
    if (dir) rmSync(dir, { recursive: true, force: true });
  } finally {
    if (previousStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorageDir;
    await tdb?.teardown();
  }
});

describe.skipIf(skipDb)("Hero 横幅池（M11）", () => {
  it("addHero：宽幅 PNG 入池并自动设为当前；审计 admin.hero.upload / targetType=hero；与 LOGO 池互不干扰", async () => {
    const ok = await addHero("新年横幅", await png(1920, 823));
    expect(ok).toMatchObject({ ok: true });
    const pool = await getHeroPoolRaw();
    expect(pool.items).toHaveLength(1);
    expect(pool.items[0]!.file).toMatch(/^hero-[a-f0-9]{32}\.png$/);
    expect(pool.active).toBe(pool.items[0]!.file);
    const [audit] = await getWebDb()
      .select({ targetType: auditLog.targetType, targetId: auditLog.targetId })
      .from(auditLog)
      .where(eq(auditLog.action, "admin.hero.upload"));
    expect(audit).toEqual({ targetType: "hero", targetId: pool.items[0]!.file });
    expect((await getLogoPoolRaw()).items).toHaveLength(0);
  });

  it("上限：非 PNG / 伪造魔数 → bad_type；>2MB → too_large；像素超 1920×1080 → oversize（且不落盘不入池）", async () => {
    expect((await addHero("文本", new Uint8Array(16))).ok).toBe(false);
    const fake = await addHero("伪造", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0]));
    expect(fake).toEqual({ ok: false, code: "bad_type" });
    const big = await addHero("太大", new Uint8Array(HERO_MAX_BYTES + 1));
    expect(big).toEqual({ ok: false, code: "too_large" });
    expect(await addHero("太宽", await png(1921, 100))).toEqual({ ok: false, code: "oversize" });
    expect(await addHero("太高", await png(100, 1081))).toEqual({ ok: false, code: "oversize" });
    expect((await getHeroPoolRaw()).items).toHaveLength(1);
  });

  it("setActive / remove：切换池内项、未知项不生效；移除当前项 → active 归 null（首页不占位）", async () => {
    const second = await addHero("第二张", await png(640, 360));
    if (!second.ok) throw new Error(second.code);
    const [first, latest] = (await getHeroPoolRaw()).items.map((i) => i.file) as [string, string];
    expect((await getHeroPoolRaw()).active).toBe(latest);

    await setActiveHero(first);
    expect((await getHeroPoolRaw()).active).toBe(first);
    await setActiveHero("hero-unknown.png");
    expect((await getHeroPoolRaw()).active).toBe(first);

    expect(await readHeroBytes()).not.toBeNull(); // 无参 = 当前项
    expect(await readHeroBytes(latest)).not.toBeNull();
    expect(await readHeroBytes("hero-not-in-pool.png")).toBeNull();
    expect(await readHeroBytes("logo-abc.png")).toBeNull(); // 前缀不符

    await removeHero(first);
    const after = await getHeroPoolRaw();
    expect(after.items.map((i) => i.file)).toEqual([latest]);
    expect(after.active).toBeNull();
    expect(await readHeroBytes()).toBeNull();
  });
});
