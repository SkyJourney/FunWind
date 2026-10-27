// @vitest-environment node
/**
 * LOGO 池集成测试（M10.5 阶段 C）：addLogo 魔数/大小/入池、setActive/remove 语义、
 * readLogoBytes 池内校验。文件落 STORAGE_DIR（测试指向系统临时目录，用后清理）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { addLogo, readLogoBytes } from "./logo-pool-fs";
import { getLogoPoolRaw, removeLogo, setActiveLogo } from "./logo-pool";

let tdb: TempDb;
let logoDir: string;

let png: Uint8Array;

beforeAll(async () => {
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  tdb = await setupTempDb({ demo: false });
  logoDir = mkdtempSync(join(tmpdir(), "fw-logo-"));
  process.env.STORAGE_DIR = logoDir;
});

afterAll(() => {
  rmSync(logoDir, { recursive: true, force: true });
  tdb?.teardown();
});

describe.skipIf(skipDb)("LOGO 池（M10.5）", () => {
  it("addLogo：PNG 入池并自动设为当前；非 PNG 与超限被拒", async () => {
    const ok = await addLogo("清爽侦探", png);
    expect(ok).toMatchObject({ ok: true });
    const pool = await getLogoPoolRaw();
    expect(pool.items).toHaveLength(1);
    expect(pool.items[0]?.name).toBe("清爽侦探");
    expect(pool.active).toBe(pool.items[0]?.file);

    const bad = await addLogo("不是图", new Uint8Array(16));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("bad_type");
    const fake = await addLogo("伪造", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0]));
    expect(fake).toEqual({ ok: false, code: "bad_type" });
    const big = await addLogo("太大", new Uint8Array(600 * 1024));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.code).toBe("too_large");
  });

  it("setActive：切到池内项；未知项不生效", async () => {
    const ok = await addLogo("第二枚", png);
    if (!ok.ok) throw new Error(ok.code);
    const second = ok.pool.items.at(-1)!.file;
    const first = (await getLogoPoolRaw()).items[0]!.file;

    await setActiveLogo(first);
    expect((await getLogoPoolRaw()).active).toBe(first);

    await setActiveLogo("logo-unknown.png");
    expect((await getLogoPoolRaw()).active).toBe(first);
    void second;
  });

  it("readLogoBytes：当前项可读；不在池内 → null；磁盘缺失 → null", async () => {
    const pool = await getLogoPoolRaw();
    const active = pool.active!;
    const bytes = (await readLogoBytes(active))!;
    expect(Buffer.from(bytes).subarray(1, 4).toString()).toBe("PNG");

    expect(await readLogoBytes("logo-not-in-pool.png")).toBeNull();
    expect(await readLogoBytes("../evil.png")).toBeNull(); // SAFE_NAME 拒绝
    expect(await readLogoBytes()).not.toBeNull(); // 无参 = 当前项

    // 池内有记录但磁盘被清 → null（容错，不抛错）
    rmSync(join(logoDir, "site", active));
    expect(await readLogoBytes(active)).toBeNull();
    void pool;
  });

  it("并发上传保留每个文件及池记录", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => addLogo(`并发${i}`, png)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const pool = await getLogoPoolRaw();
    const added = pool.items.filter((item) => item.name.startsWith("并发"));
    expect(added).toHaveLength(8);
    expect(new Set(added.map((item) => item.file)).size).toBe(8);
    for (const item of added) expect(await readLogoBytes(item.file)).toEqual(png);
  });

  it("removeLogo：移出池；移除当前项 → active 归 null（回退占位）", async () => {
    const pool = await getLogoPoolRaw();
    const files = pool.items.map((i) => i.file);
    for (const f of files) await removeLogo(f);
    const after = await getLogoPoolRaw();
    expect(after.items).toHaveLength(0);
    expect(after.active).toBeNull();
  });
});
