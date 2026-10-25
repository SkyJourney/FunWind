// @vitest-environment node
/**
 * 上传落盘与配额的真实 MySQL 集成测试（临时库 + 临时存储目录）。
 * 覆盖：去重后仍逐次计数、配额并发恰好通过 limit 次、头像同事务写入 avatar_file_id、落盘内容可读回。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { DEMO, fileUploads, files, getWebDb, siteSettings, userProfiles } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { sha256Hex, storeUpload } from "./store";
import { storageKeyFor } from "./policy";

let tdb: TempDb;
let storage: string;
const db = () => getWebDb();

const roles = (uploadsPerDay: number) => ({
  titleMax: 100,
  bodyMax: 50000,
  roles: {
    member: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay },
    admin: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 0 },
  },
});

async function setUploadsPerDay(n: number) {
  await db()
    .insert(siteSettings)
    .values({ key: "limits", value: roles(n) as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: roles(n) as object, updatedAt: sql`NOW()` } });
}

const payload = (tag: string) => Buffer.from(`上传测试内容 ${tag} ${Math.random()}`);

describe.skipIf(skipDb)("storeUpload（临时库 + 临时存储）", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    storage = mkdtempSync(join(tmpdir(), "fw-upload-store-"));
  });

  afterAll(async () => {
    await tdb?.teardown();
    if (storage) rmSync(storage, { recursive: true, force: true });
  });

  it("去重：同一字节两人上传 → 一个 files 行、两条 file_uploads 行，且两次都计入配额口径", async () => {
    await setUploadsPerDay(0);
    const bytes = payload("dedupe");
    const a = await storeUpload(
      { userId: DEMO.member, bytes, sniffed: "txt", width: null, height: null, avatar: false },
      { storageDir: storage, uploadsPerDay: 0 },
    );
    const b = await storeUpload(
      { userId: DEMO.team, bytes, sniffed: "txt", width: null, height: null, avatar: false },
      { storageDir: storage, uploadsPerDay: 0 },
    );
    if (!a.ok || !b.ok) throw new Error("上传应成功");
    expect(a.file.fileId).toBe(b.file.fileId);

    const [{ n: fileRows }] = await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(files)
      .where(eq(files.sha256, sha256Hex(bytes)));
    expect(Number(fileRows)).toBe(1);

    const uploads = await db()
      .select({ userId: fileUploads.userId })
      .from(fileUploads)
      .where(eq(fileUploads.fileId, a.file.fileId));
    expect(uploads.map((u) => u.userId).sort()).toEqual([DEMO.member, DEMO.team].sort());

    // 落盘内容可读回，且路径为内容寻址
    const key = storageKeyFor(sha256Hex(bytes), "txt");
    expect(a.file.storageKey).toBe(key);
    expect(readFileSync(join(storage, key)).equals(bytes)).toBe(true);
  });

  it("配额并发：5 路并发、限额 2 → 恰好 2 成功，3 个 quota_exceeded，file_uploads 只有 2 行", async () => {
    await setUploadsPerDay(2);
    // 用未被前面用例使用过的用户，避免今日已有计数干扰「恰好 2 次」
    const user = DEMO.alice;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        storeUpload(
          {
            userId: user,
            bytes: payload(`quota-${i}`),
            sniffed: "txt",
            width: null,
            height: null,
            avatar: false,
          },
          { storageDir: storage, uploadsPerDay: 2 },
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.code === "quota_exceeded")).toHaveLength(3);
    const [{ n }] = await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(fileUploads)
      .where(eq(fileUploads.userId, user));
    expect(Number(n)).toBe(2);
    await setUploadsPerDay(0);
  });

  it("去重命中也计入配额：限额 1，同字节第二次上传被拒", async () => {
    await setUploadsPerDay(1);
    const bytes = payload("dedupe-quota");
    const first = await storeUpload(
      { userId: DEMO.admin, bytes, sniffed: "txt", width: null, height: null, avatar: false },
      { storageDir: storage, uploadsPerDay: 1 },
    );
    const second = await storeUpload(
      { userId: DEMO.admin, bytes, sniffed: "txt", width: null, height: null, avatar: false },
      { storageDir: storage, uploadsPerDay: 1 },
    );
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, code: "quota_exceeded" });
    await setUploadsPerDay(0);
  });

  it("头像：同事务写入 user_profiles.avatar_file_id（不存在的资料行会被补上）", async () => {
    await setUploadsPerDay(0);
    const userId = DEMO.team;
    await db().delete(userProfiles).where(eq(userProfiles.userId, userId));
    const r = await storeUpload(
      { userId, bytes: payload("avatar"), sniffed: "png", width: 240, height: 240, avatar: true },
      { storageDir: storage, uploadsPerDay: 0 },
    );
    if (!r.ok) throw new Error("头像上传应成功");
    const [profile] = await db()
      .select({ avatarFileId: userProfiles.avatarFileId })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId));
    expect(profile?.avatarFileId).toBe(r.file.fileId);
  });
});
