// @vitest-environment node
/**
 * @提及集成测试（M8 S3）：发帖/回帖/编辑三处的 post.mentioned 事件经 outbox；
 * 隐藏区不解析（公开正文才提）、self 排除、编辑差集（新增才发）。
 */
import { eq, sql } from "drizzle-orm";
import { DEMO, eventOutbox, getWebDb, posts, siteSettings } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { createThread, createReply } from "./service";
import { editPost } from "./mutate";

let tdb: TempDb;
let alice: Subject;
const db = () => getWebDb();

async function editedAtOf(postId: number): Promise<string | null> {
  const [row] = await db()
    .select({ editedAt: posts.editedAt })
    .from(posts)
    .where(eq(posts.id, postId));
  return row?.editedAt ?? null;
}

async function outboxMentionsFor(postId: number, mentionedUserId: number) {
  const rows = await db()
    .select()
    .from(eventOutbox)
    .where(eq(eventOutbox.eventName, "post.mentioned"));
  return rows.filter(
    (r) =>
      (r.payload as { postId: number; mentionedUserId: number }).postId === postId &&
      (r.payload as { postId: number; mentionedUserId: number }).mentionedUserId ===
        mentionedUserId,
  );
}

beforeAll(async () => {
  tdb = await setupTempDb();
  alice = await loadSubject(DEMO.alice);
  const value = {
    titleMax: 100,
    bodyMax: 50000,
    roles: {
      member: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 20, editWindowSec: 0 },
      admin: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 0, editWindowSec: 0 },
    },
  };
  await db()
    .insert(siteSettings)
    .values({ key: "limits", value: value as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: value as object, updatedAt: sql`NOW()` } });
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("@提及（M8）", () => {
  it("发帖 @ 已存在用户：post.mentioned 事件入 outbox 且已派发", async () => {
    const out = await createThread(
      alice,
      { forumId: 901, title: "提及主题", source: "嘿 @demo_team 看看" },
      {},
    );
    if (!out.ok) throw new Error(out.message);
    const rows = await outboxMentionsFor(out.postId, DEMO.team);
    expect(rows).toHaveLength(1);
    expect(rows[0].dispatchedAt).not.toBeNull();
    expect(rows[0].source).toBe("posting");
  });

  it("回帖 @ 多人：逐人一事件；@ 不存在的名字与 @ 自己静默跳过", async () => {
    const head = await createThread(alice, { forumId: 901, title: "提及楼主", source: "正文" }, {});
    if (!head.ok) throw new Error(head.message);
    const out = await createReply(
      alice,
      { threadId: head.threadId, source: "@demo_team @不存在的名字 @demo_alice 都看看" },
      {},
    );
    if (!out.ok) throw new Error(out.message);
    expect(await outboxMentionsFor(out.postId, DEMO.team)).toHaveLength(1);
    expect(await outboxMentionsFor(out.postId, DEMO.alice)).toHaveLength(0); // self 排除
    expect(await outboxMentionsFor(out.postId, 99999999)).toHaveLength(0);
  });

  it("门控隐藏区里的 @ 不算（公开正文才解析）", async () => {
    const out = await createThread(
      alice,
      {
        forumId: 901,
        title: "隐藏区提及",
        source: '公开\n\n:::gate{unlock="points" price="1"}\n@demo_team 在门控里\n:::',
        canAddTags: false,
      },
      { emitter: async () => undefined },
    );
    if (!out.ok) throw new Error(out.message);
    // 作者 alice 自己有 gate.points 权限（词汇表 admin 基线？member 有 gate.points）——门控应能创建
    expect(await outboxMentionsFor(out.postId, DEMO.team)).toHaveLength(0);
  });

  it("编辑新增提及：只对新提及发事件；已提及过的人不重复", async () => {
    const out = await createThread(
      alice,
      { forumId: 901, title: "编辑提及", source: "原文 @demo_team" },
      {},
    );
    if (!out.ok) throw new Error(out.message);
    expect(await outboxMentionsFor(out.postId, DEMO.team)).toHaveLength(1);

    // 编辑：保留 team，新增 xiaoyi → 只有 xiaoyi 收到新事件
    const e1 = await editPost(alice, {
      postId: out.postId,
      source: "原文 @demo_team @demo_小翼",
      title: "编辑提及",
      expectedEditedAt: null,
    });
    if (!e1.ok) throw new Error(`e1: ${e1.code} ${e1.message}`);
    const teamRows = await outboxMentionsFor(out.postId, DEMO.team);
    expect(teamRows.length).toBe(1); // 不重复
    expect(await outboxMentionsFor(out.postId, DEMO.xiaoyi)).toHaveLength(1);

    // 再次编辑不加新提及：无新事件
    const e2 = await editPost(alice, {
      postId: out.postId,
      source: "原文 @demo_team @demo_小翼 改了改",
      title: "编辑提及",
      expectedEditedAt: await editedAtOf(out.postId),
    });
    if (!e2.ok) throw new Error(e2.message);
    expect(await outboxMentionsFor(out.postId, DEMO.xiaoyi)).toHaveLength(1);
  });
});
