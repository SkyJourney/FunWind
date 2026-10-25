// @vitest-environment node
/**
 * 保存时派发 attachment.uploaded（M6.5c）的真实 MySQL 测试：发主题带附件，提交后每条新建的下载附件派发一次；
 * 载荷只含 id 与上传者，不含文件名、正文或存储键。
 */
import { createHash } from "node:crypto";
import { DEMO, files, fileUploads, getWebDb } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { createThread } from "./service";

let tdb: TempDb;
let member: Subject;

describe.skipIf(skipDb)("attachment.uploaded 派发（临时库）", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    member = await loadSubject(DEMO.member);
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("发主题带两个附件：提交后派发两次 attachment.uploaded，载荷只含 id 与上传者", async () => {
    const db = getWebDb();
    const ids: number[] = [];
    for (const tag of ["ev-a", "ev-b"]) {
      const sha = createHash("sha256").update(tag).digest("hex");
      const [{ insertId }] = (await db.insert(files).values({
        sha256: sha,
        storageKey: `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.zip`,
        sizeBytes: 3,
        mime: "application/zip",
        createdAt: "2026-10-01 00:00:00",
      })) as unknown as [{ insertId: number }];
      ids.push(Number(insertId));
      await db.insert(fileUploads).values({
        userId: DEMO.member,
        fileId: Number(insertId),
        sizeBytes: 3,
        createdAt: "2026-10-01 00:00:00",
      });
    }

    const events: { name: string; payload: Record<string, unknown> }[] = [];
    const r = await createThread(
      member,
      {
        forumId: 901,
        title: "附件事件测试 很长的标题也没问题",
        source: "正文里有一段秘密文字 SECRET-EVENT",
        attachments: [
          { fileId: ids[0]!, gateKey: null, name: "私人名称-a.zip" },
          { fileId: ids[1]!, gateKey: null, name: "私人名称-b.zip" },
        ],
      },
      {
        emitter: async (name, payload) => {
          events.push({ name, payload: payload as Record<string, unknown> });
        },
      },
    );
    expect(r.ok).toBe(true);

    const uploaded = events.filter((e) => e.name === "attachment.uploaded");
    expect(uploaded).toHaveLength(2);
    for (const e of uploaded) {
      expect(Object.keys(e.payload).sort()).toEqual(["attachmentId", "fileId", "uploaderId"]);
      expect(e.payload.uploaderId).toBe(DEMO.member);
      expect(ids).toContain(e.payload.fileId);
      expect(typeof e.payload.attachmentId).toBe("number");
    }
    // 载荷里没有文件名与正文
    expect(JSON.stringify(uploaded)).not.toContain("私人名称");
    expect(JSON.stringify(uploaded)).not.toContain("SECRET-EVENT");
  });
});
