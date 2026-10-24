// @vitest-environment node
/**
 * /files 请求处理的真实 MySQL 集成测试（临时库 + 临时存储目录 + 真实文件）。
 * 夹具帖子：900101（公开版块 901 的首帖）/ 900105（受限版块 904 的首帖，仅团队可读）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { DEMO, attachments, files, getWebDb, posts } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { contentDisposition, handleFileRequest, parseFileKey } from "./file-serving";

let tdb: TempDb;
let storage: string;
let guest: Subject, member: Subject, team: Subject, admin: Subject;

const SHA = "a".repeat(64);

/** 在存储目录里落一个真实文件并登记 files 行，返回 storage_key */
async function putFile(content: string, ext: string, mime: string, writeToDisk = true) {
  const sha = createHash("sha256").update(content).digest("hex");
  const key = `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.${ext}`;
  if (writeToDisk) {
    mkdirSync(join(storage, sha.slice(0, 2), sha.slice(2, 4)), { recursive: true });
    writeFileSync(join(storage, key), content);
  }
  const [{ insertId }] = (await getWebDb().insert(files).values({
    sha256: sha,
    storageKey: key,
    sizeBytes: content.length,
    mime,
    createdAt: "2026-10-01 00:00:00",
  })) as unknown as [{ insertId: number }];
  return { key, sha, fileId: Number(insertId) };
}
const attach = (postId: number, fileId: number, originalName: string) =>
  getWebDb().insert(attachments).values({
    postId,
    fileId,
    uploaderId: DEMO.alice,
    originalName,
    createdAt: "2026-10-01 00:00:00",
  });
const get = (s: Subject, key: string, init?: RequestInit) =>
  handleFileRequest(new Request(`http://x/files/${key}`, init), key.split("/"), s, storage);
const downloads = async (id: number) =>
  (await getWebDb().select().from(attachments).where(eq(attachments.id, id)))[0]?.downloads;

describe("路径与响应头的纯函数", () => {
  it('parseFileKey：段内带 "/"（%2f 被 Next 解码进段）的别名形态一律拒绝——同一文件只能有一个 URL（M5.6 S4）', () => {
    const key = `aa/aa/${SHA}.png`;
    expect(parseFileKey(["aa", "aa", `${SHA}.png`])).toBe(key); // 对照：规范三段形态通过
    for (const alias of [
      ["aa/aa", `${SHA}.png`], // 两段：/files/aa%2faa/<sha>.png
      ["aa/aa/" + `${SHA}.png`], // 一段：全部 %2f
      ["aa", `aa/${SHA}.png`], // 仅最后一个 %2f
      ["aa/", "aa", `${SHA}.png`], // 三段但段内含斜杠
    ]) {
      expect(parseFileKey(alias), JSON.stringify(alias)).toBeNull();
    }
  });

  it("parseFileKey：只接受 ab/cd/<64位小写hex>.<ext>，且目录必须等于哈希前缀", () => {
    expect(parseFileKey(["aa", "aa", `${SHA}.png`])).toBe(`aa/aa/${SHA}.png`);
    for (const bad of [
      ["aa", "aa", `${SHA}`], // 无扩展名
      ["aa", "bb", `${SHA}.png`], // 目录与哈希前缀不符
      ["AA", "AA", `${"A".repeat(64)}.png`], // 大写
      ["aa", "aa", `${"a".repeat(63)}.png`], // 哈希过短
      ["aa", "aa", `${SHA}.png`, "x"], // 多余段
      ["..", "aa", `${SHA}.png`],
      ["aa", "aa", `${SHA}.p/ng`],
      ["aa", "aa", `${SHA}.${"x".repeat(9)}`], // 扩展名过长
      [],
    ]) {
      expect(parseFileKey(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("contentDisposition：清除换行/引号/路径符防头部注入，中文名 RFC5987 编码", () => {
    const h = contentDisposition("attachment", '字幕"\r\nX-Evil: 1\\/组.zip');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.startsWith("attachment; ")).toBe(true);
    expect(h).toContain('filename="download"');
    expect(h).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(h.split("UTF-8''")[1]!)).toBe("字幕X-Evil: 1组.zip");
    expect(contentDisposition("attachment", "a'b(c).zip")).toContain("a%27b%28c%29.zip");
    expect(decodeURIComponent(contentDisposition("attachment", "\r\n").split("UTF-8''")[1]!)).toBe(
      "download",
    );
  });
});

describe.skipIf(skipDb)("/files · 真实 MySQL", () => {
  beforeAll(async () => {
    storage = mkdtempSync(join(tmpdir(), "fw-storage-"));
    tdb = await setupTempDb();
    [guest, member, team, admin] = await Promise.all([
      loadSubject(null),
      loadSubject(DEMO.member),
      loadSubject(DEMO.team),
      loadSubject(DEMO.admin),
    ]);
  });
  afterAll(async () => {
    await tdb?.teardown();
    rmSync(storage, { recursive: true, force: true });
  });

  it("形态非法 / 库里没有的 key → 404（不探测文件系统）", async () => {
    expect((await get(guest, `aa/aa/${SHA}.png`)).status).toBe(404); // 形态合法但库里没有
    expect((await get(guest, `aa/bb/${SHA}.png`)).status).toBe(404); // 前缀不符
    expect((await get(guest, "../etc/passwd")).status).toBe(404);
  });

  it("图片对任何人公开：内容正确，Content-Type 取自数据库 mime，nosniff + CSP sandbox + immutable + ETag", async () => {
    const f = await putFile("PNG-BYTES", "png", "image/png");
    const res = await get(guest, f.key);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PNG-BYTES");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("etag")).toBe(`"${f.sha}"`);
    expect(res.headers.get("content-length")).toBe("9");
  });

  it("If-None-Match 命中 → 304，无正文", async () => {
    const f = await putFile("PNG-2", "png", "image/png");
    const res = await get(guest, f.key, { headers: { "if-none-match": `"${f.sha}"` } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("Content-Type 只信数据库：key 扩展名是 .png 但 mime 登记为 octet-stream，不会被当成图片内联", async () => {
    const f = await putFile("not really png", "png", "application/octet-stream");
    // 非图片 mime → 走附件鉴权；未被任何帖子引用 → 404
    expect((await get(guest, f.key)).status).toBe(404);
    expect((await get(member, f.key)).status).toBe(404);
  });

  it("svg 不是可内联图片：未被引用 404；被引用后也只会以 attachment 下发", async () => {
    const f = await putFile("<svg onload=alert(1)/>", "bin", "image/svg+xml");
    expect((await get(member, f.key)).status).toBe(404);
    await attach(900101, f.fileId, "x.svg");
    const res = await get(member, f.key);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("公开版块里的非图片附件：游客无 attachment.download → 404；会员 200 + 附件下载头 + 计数累加", async () => {
    const f = await putFile("ZIP-BYTES", "zip", "application/zip");
    await attach(900101, f.fileId, '字幕"\r\n组.zip');
    const [att] = await getWebDb()
      .select()
      .from(attachments)
      .where(eq(attachments.fileId, f.fileId));

    expect((await get(guest, f.key)).status).toBe(404);
    expect(await downloads(att!.id)).toBe(0);

    const res = await get(member, f.key);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ZIP-BYTES");
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="download"; filename\*=UTF-8''/,
    );
    expect(res.headers.get("content-disposition")).not.toMatch(/[\r\n]/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await downloads(att!.id)).toBe(1);

    await get(member, f.key);
    expect(await downloads(att!.id)).toBe(2);
    // HEAD 不计数
    await get(member, f.key, { method: "HEAD" });
    expect(await downloads(att!.id)).toBe(2);
  });

  it("受限版块里的附件：普通会员 404，团队成员 200，admin 200", async () => {
    const f = await putFile("SECRET-ZIP", "zip", "application/zip");
    await attach(900105, f.fileId, "内部分工.zip");
    expect((await get(guest, f.key)).status).toBe(404);
    expect((await get(member, f.key)).status).toBe(404);
    expect((await get(team, f.key)).status).toBe(200);
    expect((await get(admin, f.key)).status).toBe(200);
  });

  it("同一文件被多个帖子引用：任意一处对观众放行即可", async () => {
    const f = await putFile("SHARED-ZIP", "zip", "application/zip");
    await attach(900105, f.fileId, "内部.zip"); // 受限版块
    expect((await get(member, f.key)).status).toBe(404);
    await attach(900101, f.fileId, "公开.zip"); // 公开版块
    expect((await get(member, f.key)).status).toBe(200);
  });

  it("所在帖子被隐藏：会员 404，版主（admin）仍可取", async () => {
    const f = await putFile("HIDDEN-ZIP", "zip", "application/zip");
    await attach(900102, f.fileId, "h.zip");
    expect((await get(member, f.key)).status).toBe(200);
    await getWebDb().update(posts).set({ state: "hidden" }).where(eq(posts.id, 900102));
    expect((await get(member, f.key)).status).toBe(404);
    expect((await get(admin, f.key)).status).toBe(200);
  });

  it("管理员收回会员的 attachment.download 后立即生效（快照失效）", async () => {
    const f = await putFile("REVOKE-ZIP", "zip", "application/zip");
    await attach(900101, f.fileId, "r.zip");
    expect((await get(member, f.key)).status).toBe(200);
    await getWebDb().execute(
      sql`DELETE FROM role_grants WHERE role_key = 'member' AND permission_key = 'attachment.download'`,
    );
    invalidateAuthzSnapshot();
    expect((await get(member, f.key)).status).toBe(404);
  });

  it("数据库有记录但磁盘上缺文件 → 404（不抛 500）", async () => {
    const f = await putFile("GONE", "png", "image/png", false);
    expect((await get(guest, f.key)).status).toBe(404);
  });
});
