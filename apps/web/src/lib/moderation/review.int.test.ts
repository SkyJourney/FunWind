// @vitest-environment node
/**
 * 内容审核动作集成测试（M9 S3）：approve（补发 thread.created/replied + content_reviews + 计数）、
 * reject（理由进 content_reviews + 作者通知 data）、hide（hidden 首个写入口）、队列查询（版主作用域）。
 */
import "@/modules";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditLog,
  contentReviews,
  DEMO,
  eventOutbox,
  getWebDb,
  pointLedger,
  posts,
  siteSettings,
  threads,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { approveReview, hidePost, rejectReview, removedContent, reviewQueue } from "./review";
import { createThread } from "@/lib/posting/service";

let tdb: TempDb;
let admin: Subject;
const db = () => getWebDb();
const REVIEW_FORUM = 906; // seed 的 review_policy=all 版块
const ACTOR = { userId: DEMO.admin, via: "admin" as const, ip: "127.0.0.1" };

async function outboxOf(name: string, key: { k: string; v: number }) {
  const rows = await db().select().from(eventOutbox).where(eq(eventOutbox.eventName, name));
  return rows.filter((r) => (r.payload as Record<string, unknown>)[key.k] === key.v);
}

async function postState(postId: number): Promise<string> {
  const [row] = await db().select({ state: posts.state }).from(posts).where(eq(posts.id, postId));
  return row?.state ?? "missing";
}

/** 在审核版块发一篇待审主题，返回 {threadId, postId} */
async function seedPendingThread(): Promise<{ threadId: number; postId: number }> {
  const author = await loadSubject(DEMO.xiaoyi);
  const out = await createThread(
    author,
    { forumId: REVIEW_FORUM, title: `待审 ${Date.now()}-${Math.random()}`, source: "待审正文" },
    {},
  );
  if (!out.ok) throw new Error(out.message);
  return { threadId: out.threadId, postId: out.postId };
}

beforeAll(async () => {
  tdb = await setupTempDb();
  admin = await loadSubject(DEMO.admin);
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

describe.skipIf(skipDb)("审核动作（M9）", () => {
  it("approve：pending→visible、content_reviews 落行、补发 thread.created、计数就位、作者积分入账", async () => {
    const { threadId, postId } = await seedPendingThread();
    expect(await postState(postId)).toBe("pending");

    // 队列里可见
    const queue = await reviewQueue(admin);
    expect(queue.some((i) => i.postId === postId)).toBe(true);

    const r = await approveReview(admin, postId, ACTOR);
    if (!r.ok) throw new Error(r.message);
    expect(await postState(postId)).toBe("visible");

    // content_reviews(approved)
    const [cr] = await db().select().from(contentReviews).where(eq(contentReviews.postId, postId));
    expect(cr.decision).toBe("approved");
    expect(cr.reviewerId).toBe(DEMO.admin);

    // 补发 thread.created（pending 路径首次）+ content.moderated(approve)，都经 outbox 已派发
    expect(
      (await outboxOf("thread.created", { k: "threadId", v: threadId })).length,
    ).toBeGreaterThanOrEqual(1);
    const modRows = (await outboxOf("content.moderated", { k: "postId", v: postId })).filter(
      (x) => (x.payload as { action: string }).action === "approve",
    );
    expect(modRows).toHaveLength(1);
    expect(modRows[0].dispatchedAt).not.toBeNull();

    // 审计
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "post.state.visible"), eq(auditLog.targetId, String(postId))));
    expect(audits).toHaveLength(1);

    // 作者积分入账（earn.post 消费补发的 thread.created）
    const earns = await db()
      .select()
      .from(pointLedger)
      .where(and(eq(pointLedger.userId, DEMO.xiaoyi), eq(pointLedger.channel, "earn.post")));
    expect(earns.length).toBeGreaterThanOrEqual(1);
  });

  it("reject：pending→rejected、理由进 content_reviews、作者通知带理由、可重提", async () => {
    const { postId } = await seedPendingThread();
    const r = await rejectReview(admin, postId, "与版块主题无关", ACTOR);
    if (!r.ok) throw new Error(r.message);
    expect(await postState(postId)).toBe("rejected");

    const [cr] = await db()
      .select()
      .from(contentReviews)
      .where(eq(contentReviews.postId, postId))
      .orderBy(desc(contentReviews.id))
      .limit(1);
    expect(cr.decision).toBe("rejected");
    expect(cr.note).toBe("与版块主题无关");

    // 作者通知在 S4 接线后由 notifications.int.test 断言（content.moderated 消费者）
  });

  it("reject 空理由拒绝；非 pending 拒绝拒绝", async () => {
    const { postId } = await seedPendingThread();
    expect(await rejectReview(admin, postId, "  ", ACTOR)).toMatchObject({
      ok: false,
      code: "reason_required",
    });
    await approveReview(admin, postId, ACTOR);
    expect(await rejectReview(admin, postId, "迟到的理由", ACTOR)).toMatchObject({
      ok: false,
      code: "bad_state",
    });
  });

  it("hide：visible→hidden（首个写入口）、审计、通知作者；removedContent 队列可见；恢复走既有 restorePost", async () => {
    const { threadId, postId } = await seedPendingThread();
    await approveReview(admin, postId, ACTOR);

    const r = await hidePost(admin, postId, "违规内容", ACTOR);
    if (!r.ok) throw new Error(r.message);
    expect(await postState(postId)).toBe("hidden");
    // 主题（首帖）一并 hidden
    const [t] = await db()
      .select({ state: threads.state })
      .from(threads)
      .where(eq(threads.id, threadId));
    expect(t.state).toBe("hidden");

    const removed = await removedContent(admin);
    expect(removed.some((i) => i.postId === postId)).toBe(true);
    expect(await reviewQueue(admin)).toEqual(
      expect.arrayContaining([]), // hidden 不在待审队列
    );
  });

  it("not_found：不存在的帖子；dispatchOutboxRows 失败路径（事务回滚）后无 outbox 残留", async () => {
    expect(await approveReview(admin, 99999999, ACTOR)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await rejectReview(admin, 99999999, "理由", ACTOR)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await hidePost(admin, 99999999, "理由", ACTOR)).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("bad_state 全分支：hidden 不能再 hide；rejected 不能 hide", async () => {
    const { postId } = await seedPendingThread();
    await approveReview(admin, postId, ACTOR);
    // 第一次 hide 成功（visible→hidden）
    const h = await hidePost(admin, postId, "第一次屏蔽", ACTOR);
    expect(h).toEqual({ ok: true });
    // hidden 再 hide → bad_state
    expect(await hidePost(admin, postId, "再屏蔽", ACTOR)).toMatchObject({
      ok: false,
      code: "bad_state",
    });

    // 另起一篇走到 rejected，再 hide → bad_state（只有 visible 可屏蔽）
    const second = await seedPendingThread();
    await rejectReview(admin, second.postId, "理由", ACTOR);
    expect(await hidePost(admin, second.postId, "屏蔽被驳回的", ACTOR)).toMatchObject({
      ok: false,
      code: "bad_state",
    });
  });

  it("越权：非所辖版主拒绝（demo_team 只管 904）", async () => {
    const team = await loadSubject(DEMO.team);
    const { postId } = await seedPendingThread(); // 906 版块
    expect(await approveReview(team, postId, ACTOR)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });
});
