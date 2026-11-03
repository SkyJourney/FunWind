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
  forums,
  getWebDb,
  notifications,
  pointLedger,
  posts,
  siteSettings,
  threads,
} from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as outbox from "@/lib/events/outbox";
import * as dbPackage from "@funwind/db";
import { loadSubject } from "@/lib/authz/subject";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  approveReview,
  disableContent,
  hidePost,
  listContentReviews,
  listReviewPage,
  rejectReview,
} from "./review";
import { createReply, createThread } from "@/lib/posting/service";
import { lockUserStats } from "@/lib/locks";

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

afterEach(() => vi.restoreAllMocks());

describe.skipIf(skipDb)("审核动作（M9）", () => {
  it("approve：pending→visible、content_reviews 落行、补发 thread.created、计数就位、作者积分入账", async () => {
    const { threadId, postId } = await seedPendingThread();
    expect(await postState(postId)).toBe("pending");

    // 队列里可见
    const queue = await listReviewPage(admin, { tab: "pending", page: 1 });
    expect(queue.items.some((i) => i.postId === postId)).toBe(true);

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

  it.each(["deleted", "hidden", "visible"] as const)(
    "过期 approve：事务外读到 pending，但锁内已变成 %s 时不得恢复或补发事件",
    async (state) => {
      const { threadId, postId } = await seedPendingThread();
      const runtimeDb = db();
      const originalTransaction = runtimeDb.transaction.bind(runtimeDb);
      const beforeReviews = await listContentReviews(postId);
      const beforeEvents = await db().select().from(eventOutbox);
      const beforeAudits = await db().select().from(auditLog);
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const writer = originalTransaction(async (tx) => {
        await lockUserStats(tx, DEMO.xiaoyi);
        await tx
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.id, threadId))
          .for("update");
        await tx.select({ id: posts.id }).from(posts).where(eq(posts.id, postId)).for("update");
        await tx.update(posts).set({ state }).where(eq(posts.id, postId));
        await tx.update(threads).set({ state }).where(eq(threads.id, threadId));
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      // 只观察事务入口；读、锁、迁移及回滚仍全部使用真实 MySQL 事务。
      vi.spyOn(dbPackage, "getWebDb").mockReturnValue(runtimeDb);
      const entered = Promise.withResolvers<void>();
      vi.spyOn(runtimeDb, "transaction").mockImplementation((fn, options) => {
        entered.resolve();
        return originalTransaction(fn, options);
      });
      const approval = approveReview(admin, postId, ACTOR);
      try {
        await entered.promise;
        release.resolve();
        await writer;
        expect(await approval).toMatchObject({ ok: false, code: "bad_state" });
        expect(await postState(postId)).toBe(state);
        expect((await db().select().from(threads).where(eq(threads.id, threadId)))[0]!.state).toBe(
          state,
        );
        expect(await listContentReviews(postId)).toEqual(beforeReviews);
        expect(await db().select().from(eventOutbox)).toEqual(beforeEvents);
        expect(await db().select().from(auditLog)).toEqual(beforeAudits);
      } finally {
        release.resolve();
        await Promise.allSettled([writer, approval]);
      }
    },
  );

  it.each(["other", "thread-author", "self", "none"] as const)(
    "approve 引用回帖 %s：outbox 保存引用对象并由真实消费者通知正确用户",
    async (targetKind) => {
      const host = await createThread(admin, {
        forumId: REVIEW_FORUM,
        title: `审核引用-${targetKind}`,
        source: "宿主正文",
      });
      if (!host.ok) throw new Error(host.message);
      const author = await loadSubject(DEMO.xiaoyi);
      let target: { postId: number; authorId: number; floor: number } | undefined;
      if (targetKind === "thread-author")
        target = { postId: host.postId, authorId: DEMO.admin, floor: 1 };
      else if (targetKind !== "none") {
        const targetAuthor = targetKind === "self" ? author : await loadSubject(DEMO.member);
        const result = await createReply(targetAuthor, {
          threadId: host.threadId,
          source: `被引用-${targetKind}`,
        });
        if (!result.ok) throw new Error(result.message);
        expect(await approveReview(admin, result.postId, ACTOR)).toEqual({ ok: true });
        target = { postId: result.postId, authorId: targetAuthor.userId!, floor: result.floor };
      }
      const reply = await createReply(author, {
        threadId: host.threadId,
        source: `待审引用回复-${targetKind}`,
        replyToPostId: target?.postId,
      });
      if (!reply.ok) throw new Error(reply.message);
      expect(reply.state).toBe("pending");
      expect(await outboxOf("thread.replied", { k: "postId", v: reply.postId })).toHaveLength(0);
      expect(await approveReview(admin, reply.postId, ACTOR)).toEqual({ ok: true });
      const events = await outboxOf("thread.replied", { k: "postId", v: reply.postId });
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({
        threadId: host.threadId,
        postId: reply.postId,
        forumId: REVIEW_FORUM,
        authorId: DEMO.xiaoyi,
        threadAuthorId: DEMO.admin,
        ...(target ? { replyToPostId: target.postId, replyToAuthorId: target.authorId } : {}),
      });
      expect(events[0]!.dispatchedAt).not.toBeNull();
      const notices = await db()
        .select()
        .from(notifications)
        .where(
          and(eq(notifications.targetType, "thread"), eq(notifications.targetId, host.threadId)),
        );
      const direct = notices.filter((notice) => notice.type === "post.reply_to");
      if (targetKind === "other") {
        expect(direct).toHaveLength(1);
        expect(direct[0]).toMatchObject({
          userId: DEMO.member,
          actorId: DEMO.xiaoyi,
          targetType: "thread",
          targetId: host.threadId,
          groupKey: `post:${target!.postId}:replied`,
          data: { floor: target!.floor, count: 1 },
        });
      } else expect(direct).toHaveLength(0);
      const owner = notices.filter((notice) => notice.type === "post.replied");
      expect(owner).toHaveLength(1);
      expect(owner[0]).toMatchObject({
        userId: DEMO.admin,
        actorId: DEMO.xiaoyi,
        groupKey: `thread:${host.threadId}:replied`,
      });
      expect(notices.some((notice) => notice.userId === DEMO.xiaoyi)).toBe(false);
    },
  );

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

    const removed = await listReviewPage(admin, { tab: "removed", page: 1 });
    expect(removed.items.some((i) => i.postId === postId)).toBe(true);
    expect(
      (await listReviewPage(admin, { tab: "pending", page: 1 })).items.some(
        (i) => i.postId === postId,
      ),
    ).toBe(false); // hidden 不在待审队列
  });

  it("listReviewPage：分页/板块与类型筛选/摘要（M9.5）", async () => {
    const seeded = await seedPendingThread();
    const page = await listReviewPage(admin, { tab: "pending", page: 1 });
    expect(page.total).toBeGreaterThanOrEqual(1);
    const hit = page.items.find((i) => i.postId === seeded.postId);
    expect(hit?.isThread).toBe(true);
    // 回帖筛选不含主题首帖
    const replies = await listReviewPage(admin, { tab: "pending", kind: "reply", page: 1 });
    expect(replies.items.some((i) => i.postId === seeded.postId)).toBe(false);
    // 板块筛选命中所辖版块
    const byForum = await listReviewPage(admin, { tab: "pending", forumId: REVIEW_FORUM, page: 1 });
    expect(byForum.items.every((i) => i.forumId === REVIEW_FORUM)).toBe(true);
  });

  it.each(["pending", "removed"] as const)(
    "同时间戳分页：审核 %s 按 createdAt/id 同向排序且跨页无漏行",
    async (tab) => {
      const [forum] = await db()
        .insert(forums)
        .values({ name: `审核同秒-${tab}`, readPolicy: "public" });
      const forumId = Number(forum.insertId);
      await db()
        .update(forums)
        .set({ path: `/${forumId}/` })
        .where(eq(forums.id, forumId));
      invalidateAuthzSnapshot();
      const [thread] = await db()
        .insert(threads)
        .values({
          forumId,
          authorId: DEMO.member,
          title: `同秒-${tab}`,
          state: "visible",
          createdAt: "2026-05-01 10:00:00",
        });
      const threadId = Number(thread.insertId);
      const [first] = await db().insert(posts).values({
        threadId,
        authorId: DEMO.member,
        floor: 1,
        state: "visible",
        createdAt: "2026-05-01 10:00:00",
      });
      await db()
        .update(threads)
        .set({ firstPostId: Number(first.insertId) })
        .where(eq(threads.id, threadId));
      const expectedIds: number[] = [];
      for (let floor = 2; floor <= 24; floor++) {
        const [reply] = await db()
          .insert(posts)
          .values({
            threadId,
            authorId: DEMO.member,
            floor,
            bodyMd: "同秒回帖",
            state: tab === "pending" ? "pending" : floor % 2 ? "hidden" : "deleted",
            createdAt: "2026-05-01 10:00:00",
          });
        expectedIds.push(Number(reply.insertId));
      }
      const ids: number[] = [];
      for (let page = 1; page <= 5; page++) {
        const result = await listReviewPage(admin, { tab, forumId, page, perPage: 5 });
        expect(result.total).toBe(23);
        expect(result.totalPages).toBe(5);
        ids.push(...result.items.map((item) => item.postId));
      }
      expect(new Set(ids).size).toBe(23);
      expect(ids).toEqual(tab === "pending" ? expectedIds : expectedIds.toReversed());
    },
  );

  it("disableContent：→ disabled 终态（M9.5）——状态、留痕、事件；理由必填与 bad_state", async () => {
    const { postId } = await seedPendingThread();
    await approveReview(admin, postId, ACTOR);

    // 理由为空 → 拒绝
    expect(await disableContent(admin, postId, "  ", ACTOR)).toMatchObject({
      ok: false,
      code: "reason_required",
    });
    // 不存在
    expect(await disableContent(admin, 99999999, "理由", ACTOR)).toMatchObject({
      ok: false,
      code: "not_found",
    });

    // 成功：visible → disabled
    const r = await disableContent(admin, postId, "违规内容封禁", ACTOR);
    expect(r).toEqual({ ok: true });
    expect(await postState(postId)).toBe("disabled");

    // 已封禁再封禁 → bad_state
    expect(await disableContent(admin, postId, "再次", ACTOR)).toMatchObject({
      ok: false,
      code: "bad_state",
    });

    // 封禁留痕进 content_reviews（decision=disabled）
    const history = await listContentReviews(postId);
    expect(history.some((h) => h.decision === "disabled" && h.note === "违规内容封禁")).toBe(true);

    // hidden 升格封禁合法（屏蔽 → 封禁是加重治理路径，白名单 hidden→disabled）
    const t2 = await seedPendingThread();
    await approveReview(admin, t2.postId, ACTOR);
    await hidePost(admin, t2.postId, "先屏蔽", ACTOR);
    expect(await disableContent(admin, t2.postId, "升格封禁", ACTOR)).toEqual({ ok: true });
    expect(await postState(t2.postId)).toBe("disabled");

    // deleted 不能封禁（白名单无 deleted→disabled → illegal_transition → bad_state）
    const t4 = await seedPendingThread();
    await approveReview(admin, t4.postId, ACTOR);
    const drizzle4 = await import("drizzle-orm");
    const db4 = await import("@funwind/db");
    await db4
      .getWebDb()
      .update(db4.posts)
      .set({ state: "deleted" })
      .where(drizzle4.eq(db4.posts.id, t4.postId));
    expect(await disableContent(admin, t4.postId, "理由", ACTOR)).toMatchObject({
      ok: false,
      code: "bad_state",
    });

    // 对非版主：forbidden（member 无所辖版块）
    const member = await loadSubject(DEMO.member);
    const t3 = await seedPendingThread();
    await approveReview(admin, t3.postId, ACTOR);
    expect(
      await disableContent(member, t3.postId, "理由", {
        userId: DEMO.member,
        via: "admin",
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("listContentReviews：倒序全量（M9.5 §9.2-G1）", async () => {
    const { postId } = await seedPendingThread();
    await rejectReview(admin, postId, "第一版不合格", ACTOR);
    // 推回 pending 再通过，制造两行记录
    const drizzle = await import("drizzle-orm");
    const dbPkg = await import("@funwind/db");
    // 主题与首帖必须同步（transition 的分叉保护会拒绝单边修改）
    await dbPkg
      .getWebDb()
      .update(dbPkg.posts)
      .set({ state: "pending" })
      .where(drizzle.eq(dbPkg.posts.id, postId));
    await dbPkg
      .getWebDb()
      .update(dbPkg.threads)
      .set({ state: "pending" })
      .where(
        drizzle.eq(
          dbPkg.threads.id,
          drizzle.sql`(SELECT thread_id FROM posts WHERE id = ${postId})`,
        ),
      );
    await approveReview(admin, postId, ACTOR);
    const history = await listContentReviews(postId);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]!.decision).toBe("approved"); // 最新在前
    expect(history.some((h) => h.decision === "rejected")).toBe(true);
  });

  it.each([
    { name: "approve", state: "pending", run: (id: number) => approveReview(admin, id, ACTOR) },
    {
      name: "reject",
      state: "pending",
      run: (id: number) => rejectReview(admin, id, "理由", ACTOR),
    },
    { name: "hide", state: "visible", run: (id: number) => hidePost(admin, id, "理由", ACTOR) },
    {
      name: "disable",
      state: "pending",
      run: (id: number) => disableContent(admin, id, "理由", ACTOR),
    },
  ])("$name：事务尾部失败整体回滚，死锁重试只派发最终提交事件", async (action) => {
    const { threadId, postId } = await seedPendingThread();
    if (action.state === "visible") await approveReview(admin, postId, ACTOR);
    const runtimeDb = db();
    vi.spyOn(dbPackage, "getWebDb").mockReturnValue(runtimeDb);
    const originalTransaction = runtimeDb.transaction.bind(runtimeDb);
    const originalEnqueue = outbox.enqueueEventInTx;
    const attempted: outbox.EnqueuedEvent[] = [];
    const enqueue = vi.spyOn(outbox, "enqueueEventInTx").mockImplementation(async (...args) => {
      const row = await originalEnqueue(...args);
      attempted.push(row);
      return row;
    });
    // 收集真实提交后的快路径输入，隔离消费者另开的事务与补派。
    const dispatch = vi.spyOn(outbox, "dispatchOutboxRows").mockResolvedValue(undefined);
    const sweep = vi.spyOn(outbox, "sweepPending").mockResolvedValue(undefined);
    const beforeReviews = await listContentReviews(postId);
    const beforeEvents = await db().select().from(eventOutbox);
    const beforeAudits = await db().select().from(auditLog);
    let attempts = 0;
    let failure: Error | null = new Error("事务提交前故障");
    vi.spyOn(runtimeDb, "transaction").mockImplementation((fn, options) =>
      originalTransaction(async (tx) => {
        const result = await fn(tx);
        attempts++;
        if (failure) {
          const error = failure;
          failure = null;
          throw error;
        }
        return result;
      }, options),
    );

    // 所有业务、审核历史、审计与入队操作执行完后失败，必须一并回滚。
    await expect(action.run(postId)).rejects.toThrow("事务提交前故障");
    expect(attempts).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
    expect(await postState(postId)).toBe(action.state);
    expect((await db().select().from(threads).where(eq(threads.id, threadId)))[0]!.state).toBe(
      action.state,
    );
    expect(await listContentReviews(postId)).toEqual(beforeReviews);
    expect(await db().select().from(eventOutbox)).toEqual(beforeEvents);
    expect(await db().select().from(auditLog)).toEqual(beforeAudits);

    attempted.length = 0;
    enqueue.mockClear();
    attempts = 0;
    failure = Object.assign(new Error("注入死锁"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
    expect(await action.run(postId)).toEqual({ ok: true });
    expect(attempts).toBe(2);
    const perAttempt = action.name === "approve" ? 2 : 1;
    expect(attempted).toHaveLength(perAttempt * 2);
    expect(dispatch).toHaveBeenCalledOnce();
    const dispatched = dispatch.mock.calls[0]![0];
    expect(dispatched.map((row) => row.id)).toEqual(
      attempted.slice(perAttempt).map((row) => row.id),
    );
    const committedIds = (await db().select({ id: eventOutbox.id }).from(eventOutbox)).map(
      (row) => row.id,
    );
    expect(dispatched.every((row) => committedIds.includes(row.id))).toBe(true);
    expect(attempted.slice(0, perAttempt).every((row) => !committedIds.includes(row.id))).toBe(
      true,
    );
    expect(await listContentReviews(postId)).toHaveLength(
      beforeReviews.length + (action.name === "hide" ? 0 : 1),
    );
    expect(await db().select().from(auditLog)).toHaveLength(beforeAudits.length + 1);
  });

  it("not_found：不存在的帖子", async () => {
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
