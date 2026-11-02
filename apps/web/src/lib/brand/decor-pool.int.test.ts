// @vitest-environment node
/**
 * 主题装饰素材池集成测试（M11.1 Step 4）：brand-pool 第三实例 decor——
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
import { addDecor, DECOR_MAX_BYTES, readDecorBytes } from "./decor-pool-fs";
import { getDecorPoolRaw, removeDecor, setActiveDecor } from "./decor-pool";
import { getLogoPoolRaw } from "./logo-pool";

let tdb: TempDb | undefined;
let dir: string | undefined;
const previousStorageDir = process.env.STORAGE_DIR;

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#8b7d6b" } })
    .png()
    .toBuffer();

beforeAll(async () => {
  tdb = await setupTempDb({ demo: false });
  dir = mkdtempSync(join(tmpdir(), "fw-decor-"));
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

describe.skipIf(skipDb)("主题装饰素材池（M11.1）", () => {
  it("addDecor：大图 PNG 入池并自动设为当前；审计 admin.decor.upload / targetType=decor；与 LOGO 池互不干扰", async () => {
    const ok = await addDecor("纸纹底", await png(1600, 900));
    expect(ok).toMatchObject({ ok: true });
    const pool = await getDecorPoolRaw();
    expect(pool.items).toHaveLength(1);
    expect(pool.items[0]!.file).toMatch(/^decor-[a-f0-9]{32}\.png$/);
    expect(pool.items[0]!.name).toBe("纸纹底");
    expect(pool.active).toBe(pool.items[0]!.file);
    const [audit] = await getWebDb()
      .select({ targetType: auditLog.targetType, targetId: auditLog.targetId })
      .from(auditLog)
      .where(eq(auditLog.action, "admin.decor.upload"));
    expect(audit).toMatchObject({ targetType: "decor", targetId: pool.items[0]!.file });
    expect((await getLogoPoolRaw()).items).toHaveLength(0);
  });

  it("上限：非 PNG / 伪造魔数 → bad_type；超字节 → too_large；超像素 → oversize（均不入池）", async () => {
    const before = (await getDecorPoolRaw()).items.length;
    expect((await addDecor("文本", new Uint8Array(16))).ok).toBe(false);
    const fake = await addDecor(
      "伪造",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0]),
    );
    expect(fake).toEqual({ ok: false, code: "bad_type" });
    const big = await addDecor("太大", new Uint8Array(DECOR_MAX_BYTES + 1));
    expect(big).toEqual({ ok: false, code: "too_large" });
    const tall = await addDecor("太高", await png(100, 2161));
    expect(tall).toEqual({ ok: false, code: "oversize" });
    const wide = await addDecor("太宽", await png(3841, 100));
    expect(wide).toEqual({ ok: false, code: "oversize" });
    expect((await getDecorPoolRaw()).items).toHaveLength(before);
  });

  it("setActive / remove：切换池内项、未知项不生效；移除当前项 → active 归 null（主题回退纯色/渐变）", async () => {
    const second = await addDecor("第二张", await png(800, 600));
    if (!second.ok) throw new Error(second.code);
    const files = (await getDecorPoolRaw()).items.map((i) => i.file);
    expect(files).toHaveLength(2);
    const [first, latest] = files as [string, string];

    await setActiveDecor(first);
    expect((await getDecorPoolRaw()).active).toBe(first);
    await setActiveDecor(null);
    expect((await getDecorPoolRaw()).active).toBeNull();
    await setActiveDecor(first);
    await setActiveDecor("decor-unknown.png");
    expect((await getDecorPoolRaw()).active).toBe(first);

    expect(await readDecorBytes()).not.toBeNull();
    expect(await readDecorBytes("decor-not-in-pool.png")).toBeNull();
    expect(await readDecorBytes("logo-abc.png")).toBeNull(); // 前缀不符

    await removeDecor(first);
    const after = await getDecorPoolRaw();
    expect(after.items.map((i) => i.file)).toEqual([latest]);
    expect(after.active).toBeNull();
    expect(await readDecorBytes()).toBeNull();

    const [removeAudit] = await getWebDb()
      .select({ targetType: auditLog.targetType })
      .from(auditLog)
      .where(eq(auditLog.action, "admin.decor.remove"));
    expect(removeAudit).toMatchObject({ targetType: "decor" });
  });
});
