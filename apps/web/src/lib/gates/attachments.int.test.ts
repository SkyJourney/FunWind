// @vitest-environment node
/**
 * 门控附件的真实 MySQL 集成测试（临时库 + 演示夹具 + 临时存储目录）。
 * 夹具：主题 900004（版块 901，作者 alice）首帖 900104 含两个门控——
 *   9001 积分 10（demo_member 已购买）；9002 回复可见。
 * 核心断言：① 帖子页列表与 /files 的结论不可分叉；② 锁定项的序列化里没有任何文件元数据；
 *          ③ fail-closed（悬空 / 跨帖）；④ 门控图片不进共享缓存。
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { DEMO, attachments, files, getWebDb } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { handleFileRequest } from "@/lib/file-serving";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { listAttachments, recordDownload, type AttachmentView } from "./attachments";

const THREAD = { id: 900004, forumId: 901 };
const POSTS: { id: number; authorId: number }[] = [{ id: DEMO.gatePost, authorId: DEMO.alice }];
/** 另一个帖子（同版块、不同主题）：用来造「门控属于别的帖子」的跨帖附件 */
const OTHER_THREAD = { id: 900001, forumId: 901 };
const OTHER_POSTS: { id: number; authorId: number }[] = [{ id: 900101, authorId: DEMO.alice }];

let tdb: TempDb;
let storage: string;
let guest: Subject, alice: Subject, member: Subject, xiaoyi: Subject, admin: Subject;

interface Fx {
  name: string;
  key: string;
  attId: number;
  image: boolean;
}
const fx: Record<string, Fx> = {};

async function addAttachment(
  tag: string,
  postId: number,
  gateId: number | null,
  ext: string,
  mime: string,
  /** 复用已有文件（哈希去重）：传入已登记的 tag */
  reuse?: string,
) {
  const content = `CONTENT-${tag}`;
  const sha = createHash("sha256").update(content).digest("hex");
  const key = `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.${ext}`;
  const db = getWebDb();
  let fileId: number;
  if (reuse) {
    const [f] = await db.select().from(files).where(eq(files.storageKey, fx[reuse]!.key));
    fileId = f!.id;
  } else {
    mkdirSync(join(storage, sha.slice(0, 2), sha.slice(2, 4)), { recursive: true });
    writeFileSync(join(storage, key), content);
    const [{ insertId }] = (await db.insert(files).values({
      sha256: sha,
      storageKey: key,
      sizeBytes: content.length,
      mime,
      createdAt: "2026-10-01 00:00:00",
    })) as unknown as [{ insertId: number }];
    fileId = Number(insertId);
  }
  const name = `${tag}.${ext}`;
  const [{ insertId: attId }] = (await db.insert(attachments).values({
    postId,
    gateId,
    fileId,
    uploaderId: DEMO.alice,
    originalName: name,
    createdAt: "2026-10-01 00:00:00",
  })) as unknown as [{ insertId: number }];
  fx[tag] = {
    name,
    key: reuse ? fx[reuse]!.key : key,
    attId: Number(attId),
    image: mime.startsWith("image/"),
  };
}

const list = async (s: Subject, thread = THREAD, postList = POSTS) =>
  listAttachments(s, thread, postList);
const flat = (m: Map<number, AttachmentView[]>) => [...m.values()].flat();
const openNames = (m: Map<number, AttachmentView[]>) =>
  flat(m)
    .filter((a) => a.status === "open")
    .map((a) => a.originalName)
    .sort();
const get = (s: Subject, key: string, init?: RequestInit) =>
  handleFileRequest(new Request(`http://x/files/${key}`, init), key.split("/"), s, storage);

describe.skipIf(skipDb)("门控附件 · 真实 MySQL", () => {
  beforeAll(async () => {
    storage = mkdtempSync(join(tmpdir(), "att-gate-storage-"));
    tdb = await setupTempDb();
    [guest, alice, member, xiaoyi, admin] = await Promise.all([
      loadSubject(null),
      loadSubject(DEMO.alice),
      loadSubject(DEMO.member),
      loadSubject(DEMO.xiaoyi),
      loadSubject(DEMO.admin),
    ]);
    const P = DEMO.gatePost;
    await addAttachment("公开包", P, null, "zip", "application/zip");
    await addAttachment("付费包", P, DEMO.pointsGate, "zip", "application/zip");
    await addAttachment("回复包", P, DEMO.replyGate, "zip", "application/zip");
    await addAttachment("悬空包", P, 999999, "zip", "application/zip");
    await addAttachment("付费图", P, DEMO.pointsGate, "png", "image/png");
    await addAttachment("公开图", P, null, "png", "image/png");
    // 跨帖：附件在帖 900101，却指向帖 900104 的门控
    await addAttachment("跨帖包", 900101, DEMO.pointsGate, "zip", "application/zip");
    // 同一张图被「门控引用」与「公开引用」同时持有 → 内容本来就公开
    await addAttachment("共享图", P, DEMO.pointsGate, "png", "image/png");
    await addAttachment("共享图公开引用", P, null, "png", "image/png", "共享图");
  });
  afterAll(async () => {
    await tdb?.teardown();
    rmSync(storage, { recursive: true, force: true });
  });

  it("游客：只有未绑定门控的附件是开放的；锁定项序列化后没有任何文件元数据", async () => {
    const m = await list(guest);
    expect(openNames(m)).toEqual(["公开包.zip", "公开图.png", "共享图公开引用.png"].sort());
    const locked = flat(m).filter((a) => a.status === "locked");
    expect(locked.length).toBe(5); // 付费包 回复包 悬空包 付费图 共享图
    const dump = JSON.stringify(locked);
    for (const tag of ["付费包", "回复包", "悬空包", "付费图", "共享图"]) {
      expect(dump, tag).not.toContain(tag);
      expect(dump, tag).not.toContain(fx[tag]!.key);
    }
    expect(dump).not.toMatch(/storageKey|originalName|sizeBytes|downloads/);
  });

  it("作者与版主：能取到全部门控内的附件；悬空的对所有人锁定（fail-closed）", async () => {
    const expected = [
      "公开包.zip",
      "公开图.png",
      "共享图.png",
      "共享图公开引用.png",
      "付费包.zip",
      "付费图.png",
      "回复包.zip",
    ].sort();
    expect(openNames(await list(alice))).toEqual(expected);
    expect(openNames(await list(admin))).toEqual(expected);
    const dangling = flat(await list(admin)).filter((a) => a.status === "locked");
    expect(dangling).toEqual([{ status: "locked", postId: DEMO.gatePost, gateKey: null }]);
  });

  it("已购买付费门控的会员：付费附件开放，回复门控的仍锁；未购买的会员与游客一样", async () => {
    expect(openNames(await list(member))).toEqual(
      [
        "公开包.zip",
        "公开图.png",
        "共享图.png",
        "共享图公开引用.png",
        "付费包.zip",
        "付费图.png",
      ].sort(),
    );
    expect(openNames(await list(xiaoyi))).toEqual(
      ["公开包.zip", "公开图.png", "共享图公开引用.png"].sort(),
    );
  });

  it("锁定项带归属门控的 key（门控卡片本来就对观众可见）", async () => {
    const locked = flat(await list(xiaoyi)).filter((a) => a.status === "locked");
    expect(locked.map((a) => (a.status === "locked" ? a.gateKey : "x")).sort()).toEqual(
      ["a1", "a1", "a1", "a2", null].sort(),
    );
  });

  it("跨帖：附件挂在 A 帖却指向 B 帖的门控 → 锁定（连版主也不放行）", async () => {
    const m = await list(admin, OTHER_THREAD, OTHER_POSTS);
    expect(flat(m)).toEqual([{ status: "locked", postId: 900101, gateKey: null }]);
    expect((await get(admin, fx["跨帖包"]!.key)).status).toBe(404);
  });

  it("两条链路不可分叉：对每个有下载权限的观众，列表里 open ⇔ /files 返回 200", async () => {
    const all = Object.keys(fx);
    for (const [label, s] of [
      ["alice", alice],
      ["member", member],
      ["xiaoyi", xiaoyi],
      ["admin", admin],
    ] as const) {
      const open = new Set(openNames(await list(s)));
      for (const tag of all) {
        const f = fx[tag]!;
        if (tag === "跨帖包") continue; // 不在本主题列表里，上面单独断言
        // 共享图/共享图公开引用是同一个文件：以「是否有任一开放引用或公开」为准
        const status = (await get(s, f.key)).status;
        const listed =
          open.has(f.name) || (f.key === fx["共享图"]!.key && open.has("共享图公开引用.png"));
        expect(status === 200, `${label} · ${tag}`).toBe(listed);
      }
    }
  });

  it("游客对图片：门控图片 404，公开图片 200，共享（含公开引用）的图片 200", async () => {
    expect((await get(guest, fx["付费图"]!.key)).status).toBe(404);
    expect((await get(guest, fx["公开图"]!.key)).status).toBe(200);
    expect((await get(guest, fx["共享图"]!.key)).status).toBe(200);
    // 非图片：游客没有 attachment.download，门控与否都是 404
    expect((await get(guest, fx["公开包"]!.key)).status).toBe(404);
    expect((await get(guest, fx["付费包"]!.key)).status).toBe(404);
  });

  it("缓存：经门控放行的图片 private/no-store，无 ETag 且不走 304；公开图片仍是 immutable + ETag", async () => {
    const gated = await get(member, fx["付费图"]!.key);
    expect(gated.status).toBe(200);
    expect(gated.headers.get("cache-control")).toBe("private, no-store");
    expect(gated.headers.get("etag")).toBeNull();
    expect(gated.headers.get("content-disposition")).toBe("inline");
    const sha = fx["付费图"]!.key.split("/")[2]!.replace(/\.png$/, "");
    const revalidated = await get(member, fx["付费图"]!.key, {
      headers: { "if-none-match": `"${sha}"` },
    });
    expect(revalidated.status).toBe(200); // 不因 ETag 命中就绕过鉴权

    const pub = await get(guest, fx["公开图"]!.key);
    expect(pub.headers.get("cache-control")).toContain("immutable");
    expect(pub.headers.get("etag")).not.toBeNull();
  });

  it("下载计数只在放行后累加：游客 404 / 未购买 404 不计数，会员 200 计数", async () => {
    const id = fx["付费包"]!.attId;
    const downloads = async () =>
      (await getWebDb().select().from(attachments).where(eq(attachments.id, id)))[0]!.downloads;
    const base = await downloads(); // 前面的对账用例已经以各观众身份取过，取当前值作基线
    await get(guest, fx["付费包"]!.key);
    await get(xiaoyi, fx["付费包"]!.key); // 未购买
    expect(await downloads()).toBe(base);
    expect((await get(member, fx["付费包"]!.key)).status).toBe(200);
    expect(await downloads()).toBe(base + 1);
    // HEAD 不计数
    await get(member, fx["付费包"]!.key, { method: "HEAD" });
    expect(await downloads()).toBe(base + 1);
    await recordDownload(id);
    expect(await downloads()).toBe(base + 2);
  });

  it("空输入：没有帖子 → 空结果；没有附件的帖子不出现", async () => {
    expect((await listAttachments(guest, THREAD, [])).size).toBe(0);
    expect(
      (await listAttachments(guest, THREAD, [{ id: 900102, authorId: DEMO.alice }])).size,
    ).toBe(0);
  });
});
