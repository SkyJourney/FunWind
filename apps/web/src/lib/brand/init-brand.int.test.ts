// @vitest-environment node
/**
 * 默认站标初始化集成测试（M13 Step 4，D2）：池空 → 定稿图入池并设当前；
 * 已有当前项 → 跳过（不覆盖站长自定义）；包项在池但 active 被清空 → 复用不重复导入。
 * 使用真实定稿图 public/logo/qy2010.png 端到端（与生产 init-brand 完全同径）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { CLI_ACTOR } from "@/lib/audit";
import { addLogo } from "./logo-pool-fs";
import { getLogoPoolRaw, setActiveLogo } from "./logo-pool";
import { ensureDefaultLogo } from "./init-brand";

let tdb: TempDb | undefined;
let logoDir: string | undefined;
const previousStorageDir = process.env.STORAGE_DIR;
let customPng: Uint8Array;

beforeAll(async () => {
  customPng = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } })
    .png()
    .toBuffer();
  tdb = await setupTempDb({ demo: false });
  logoDir = mkdtempSync(join(tmpdir(), "fw-initbrand-"));
  process.env.STORAGE_DIR = logoDir;
});

afterAll(async () => {
  try {
    if (logoDir) rmSync(logoDir, { recursive: true, force: true });
  } finally {
    if (previousStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorageDir;
    await tdb?.teardown();
  }
});

describe.skipIf(skipDb)("ensureDefaultLogo（M13 D2 默认站标）", () => {
  it("池空：定稿图入池并设为当前，内容与 public/logo/qy2010.png 一致", async () => {
    const result = await ensureDefaultLogo();
    expect(result).toMatchObject({ action: "initialized" });
    const pool = await getLogoPoolRaw();
    expect(pool.items).toHaveLength(1);
    expect(pool.items[0]).toMatchObject({ name: "清爽侦探半翼", pack: "qy2010" });
    expect(pool.active).toBe((result as { file: string }).file);
    // 文件半：落盘字节与源定稿图一致
    const stored = readFileSync(join(logoDir!, "site", pool.active!));
    const source = readFileSync(join(process.cwd(), "public", "logo", "qy2010.png"));
    expect(Buffer.compare(Buffer.from(stored), Buffer.from(source))).toBe(0);
  });

  it("池已有当前项：跳过且不覆盖（站长自定义优先）", async () => {
    const added = await addLogo("站长自定义", customPng, undefined, { preserveActive: true });
    expect(added).toMatchObject({ ok: true });
    await setActiveLogo(added.ok ? added.file : "", CLI_ACTOR);

    const result = await ensureDefaultLogo();
    expect(result).toMatchObject({ action: "skipped-active" });
    const pool = await getLogoPoolRaw();
    expect(pool.items).toHaveLength(2); // 未重复导入
    expect(pool.active).toBe(added.ok ? added.file : null);
  });

  it("包项在池但 active 被清空：复用原项激活，不重复导入", async () => {
    await setActiveLogo(null, CLI_ACTOR); // 模拟历史态：池里有 qy2010 项但无当前
    const before = await getLogoPoolRaw();
    expect(before.active).toBeNull();

    const result = await ensureDefaultLogo();
    expect(result).toMatchObject({ action: "initialized" });
    const after = await getLogoPoolRaw();
    expect(after.items).toHaveLength(2); // 长度不变
    expect(after.active).toBe((result as { file: string }).file);
    expect(after.items.find((i) => i.file === after.active)?.pack).toBe("qy2010");
  });
});
