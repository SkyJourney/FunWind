// @vitest-environment node
/**
 * 保存时登记正文引用与附件（M6.4d1）的真实 MySQL 集成测试（临时库）。
 * 覆盖：归属通过 / 拒绝、文件缺失、旧引用例外（含已失效的旧引用）、门控映射、附件对账（缺失保留 / 空列表清空）、
 * 门控归属非法、门控删除只被下载附件阻止、编辑视图读取。
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  DEMO,
  attachments,
  fileUploads,
  files,
  getWebDb,
  postGates,
  posts,
  threads,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  gatesWithAttachments,
  listEditableAttachments,
  registerSourceFiles,
  type AttachmentInput,
} from "./attachments";

let tdb: TempDb;
const T = 990501;
const P = 990511;
const G1 = 990601;
const T_TIME = "2026-10-01 00:00:00";
const alice = DEMO.alice;
const member = DEMO.member;

async function mkFile(
  text: string,
  owner: number | null,
): Promise<{ fileId: number; key: string }> {
  const sha = createHash("sha256").update(text).digest("hex");
  const key = `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.png`;
  const [{ insertId }] = (await getWebDb().insert(files).values({
    sha256: sha,
    storageKey: key,
    sizeBytes: text.length,
    mime: "image/png",
    createdAt: T_TIME,
  })) as unknown as [{ insertId: number }];
  const fileId = Number(insertId);
  if (owner !== null) {
    await getWebDb()
      .insert(fileUploads)
      .values({ userId: owner, fileId, sizeBytes: text.length, createdAt: T_TIME });
  }
  return { fileId, key };
}

/** 在事务里跑登记，返回结果（失败分支不写库，结果即结论） */
const register = (opts: {
  source: string;
  attachments?: AttachmentInput[];
  priorRefs?: Set<string>;
  authorId?: number;
  canUpload?: boolean;
}) =>
  getWebDb().transaction((tx) =>
    registerSourceFiles(tx, {
      postId: P,
      authorId: opts.authorId ?? alice,
      source: opts.source,
      attachments: opts.attachments,
      priorRefs: opts.priorRefs,
      canUpload: opts.canUpload ?? true,
    }),
  );

const rowsOf = (kind: "inline" | "download") =>
  getWebDb()
    .select({ id: attachments.id, fileId: attachments.fileId, gateId: attachments.gateId })
    .from(attachments)
    .where(and(eq(attachments.postId, P), eq(attachments.kind, kind)));

const gate = (key: string, body: string) =>
  `:::gate{key="${key}" unlock="points" price="10"}\n${body}\n:::`;

describe.skipIf(skipDb)("登记正文引用与附件（临时库）", () => {
  let fileA: { fileId: number; key: string };
  let fileB: { fileId: number; key: string };
  let fileD: { fileId: number; key: string };

  beforeAll(async () => {
    tdb = await setupTempDb();
    const db = getWebDb();
    await db.insert(threads).values({
      id: T,
      forumId: 901,
      authorId: alice,
      title: "登记测试",
      firstPostId: P,
      state: "visible",
      createdAt: T_TIME,
      lastPostedAt: T_TIME,
    });
    await db.insert(posts).values({
      id: P,
      threadId: T,
      floor: 1,
      authorId: alice,
      bodyMd: "",
      hasGate: true,
      state: "visible",
      createdAt: T_TIME,
    });
    await db.insert(postGates).values({
      id: G1,
      postId: P,
      gateKey: "g1",
      conditions: [{ type: "points", price: 10 }] as never,
      matchMode: "all",
      hiddenMd: "隐藏",
      createdAt: T_TIME,
      updatedAt: T_TIME,
    });
    fileA = await mkFile("登记-A", alice);
    fileB = await mkFile("登记-B（只属于会员）", member);
    fileD = await mkFile("登记-D", alice);
  });

  afterAll(async () => {
    await tdb?.teardown();
  });

  it("归属通过：作者上传过的公开引用登记为 inline 行；重复保存幂等", async () => {
    const source = `正文 ![a](/files/${fileA.key})`;
    expect(await register({ source })).toEqual({ ok: true });
    const once = await rowsOf("inline");
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ fileId: fileA.fileId, gateId: null });
    expect(await register({ source })).toEqual({ ok: true });
    expect(await rowsOf("inline")).toHaveLength(1);
  });

  it("归属拒绝：引用别人上传的图片 → file_not_owned，且不写入任何行", async () => {
    const before = (await rowsOf("inline")).length;
    const r = await register({ source: `![b](/files/${fileB.key})` });
    expect(r).toMatchObject({ ok: false, code: "file_not_owned" });
    expect((await rowsOf("inline")).length).toBe(before);
  });

  it("文件缺失：引用不存在的 key → file_missing", async () => {
    const r = await register({ source: `![x](/files/aa/aa/${"a".repeat(64)}.png)` });
    expect(r).toMatchObject({ ok: false, code: "file_missing" });
  });

  it("旧引用例外：旧正文里已有、未被改动的引用不重新校验归属（迁移来的图）", async () => {
    const legacy = await mkFile("登记-旧图", null); // 无人上传记录
    const r = await register({
      source: `![l](/files/${legacy.key})`,
      priorRefs: new Set([legacy.key]),
    });
    expect(r).toEqual({ ok: true });
    expect((await rowsOf("inline")).some((x) => x.fileId === legacy.fileId)).toBe(true);
  });

  it("旧引用已失效且未改动：不阻塞编辑，跳过登记；新增的失效引用仍拒绝", async () => {
    const gone = `aa/aa/${"aa".repeat(32)}.png`; // 合法形态（目录与哈希前缀一致），但库里没有
    expect(await register({ source: `![g](/files/${gone})`, priorRefs: new Set([gone]) })).toEqual({
      ok: true,
    });
    expect(await register({ source: `![g](/files/${gone})` })).toMatchObject({
      code: "file_missing",
    });
  });

  it("门控映射：门控正文里的引用登记为该门控的 inline 行（gate_id 指向本帖门控）", async () => {
    const source = `${gate("g1", `![h](/files/${fileD.key})`)}`;
    expect(await register({ source })).toEqual({ ok: true });
    const rows = (await rowsOf("inline")).filter((x) => x.fileId === fileD.fileId);
    expect(rows).toEqual([expect.objectContaining({ gateId: G1 })]);
  });

  it("门控删除拦截：只有 download 行阻止门控删除；inline 行不阻止", async () => {
    expect(await gatesWithAttachments(getWebDb(), [G1])).toEqual(new Set());
    await register({
      source: "正文",
      attachments: [{ fileId: fileD.fileId, gateKey: "g1", name: "d.zip" }],
    });
    expect(await gatesWithAttachments(getWebDb(), [G1])).toEqual(new Set([G1]));
  });

  it("附件对账：列表增删改；字段缺失（undefined）不动已有附件；空列表明确清空", async () => {
    const r1 = await register({
      source: "正文",
      attachments: [
        { fileId: fileA.fileId, gateKey: null, name: "a.zip" },
        { fileId: fileD.fileId, gateKey: "g1", name: "d.zip" },
      ],
    });
    expect(r1).toEqual({ ok: true });
    expect((await rowsOf("download")).map((r) => r.fileId).sort()).toEqual(
      [fileA.fileId, fileD.fileId].sort(),
    );

    // 字段缺失：保持不变
    expect(await register({ source: "正文" })).toEqual({ ok: true });
    expect((await rowsOf("download")).length).toBe(2);

    // 去掉 A、把 D 改为公开
    await register({
      source: "正文",
      attachments: [{ fileId: fileD.fileId, gateKey: null, name: "d.zip" }],
    });
    const after = await rowsOf("download");
    expect(after).toEqual([expect.objectContaining({ fileId: fileD.fileId, gateId: null })]);

    // 空列表：清空
    expect(await register({ source: "正文", attachments: [] })).toEqual({ ok: true });
    expect(await rowsOf("download")).toEqual([]);
  });

  it("附件的门控 key 不存在于本帖 → attachment_gate_invalid", async () => {
    const r = await register({
      source: "正文",
      attachments: [{ fileId: fileA.fileId, gateKey: "nope", name: "a.zip" }],
    });
    expect(r).toMatchObject({ ok: false, code: "attachment_gate_invalid" });
  });

  it("编辑视图：只列下载附件，带门控 key（内联行不出现）", async () => {
    await register({
      source: `${gate("g1", "隐藏")}`,
      attachments: [{ fileId: fileD.fileId, gateKey: "g1", name: "编辑视图.zip" }],
    });
    const list = await listEditableAttachments(P);
    expect(list).toEqual([
      expect.objectContaining({ fileId: fileD.fileId, name: "编辑视图.zip", gateKey: "g1" }),
    ]);
  });
  it("旧引用不能认领别人受保护的文件：旧正文里的链接指向别人帖子的附件 → file_not_owned（购买者复制链接的场景）", async () => {
    // 会员的一个帖子挂着 fileB（非门控下载行）；作者 alice 的旧正文里被写入了 fileB 的链接
    const memberPost = 990521;
    await getWebDb().insert(posts).values({
      id: memberPost,
      threadId: T,
      floor: 9,
      authorId: member,
      bodyMd: "",
      hasGate: false,
      state: "visible",
      createdAt: T_TIME,
    });
    await getWebDb().insert(attachments).values({
      postId: memberPost,
      gateId: null,
      fileId: fileB.fileId,
      uploaderId: member,
      originalName: "b.zip",
      kind: "download",
      createdAt: T_TIME,
    });
    const r = await register({
      source: `![b](/files/${fileB.key})`,
      priorRefs: new Set([fileB.key]),
    });
    expect(r).toMatchObject({ ok: false, code: "file_not_owned" });
  });

  it("上传权限：无 attachment.upload 时，新增归属被拒（upload_forbidden）；已被本帖引用的文件仍放行", async () => {
    const fresh = await mkFile("登记-新文件（无权上传）", alice);
    expect(await register({ source: `![n](/files/${fresh.key})`, canUpload: false })).toMatchObject(
      {
        ok: false,
        code: "upload_forbidden",
      },
    );
    // fileA 先由本帖正文引用（有 inline 行）：之后即使无上传权限，保存也不应因它被拒
    expect(await register({ source: `![a](/files/${fileA.key})` })).toEqual({ ok: true });
    expect(await register({ source: `![a](/files/${fileA.key})`, canUpload: false })).toEqual({
      ok: true,
    });
  });
});
