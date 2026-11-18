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
  manageApiIdempotency,
  notifications,
  pointLedger,
  posts,
  siteSettings,
  threads,
} from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as outbox from "@/lib/events/outbox";
import * as dbPackage from "@funwind/db";
import { assignUserRole, createCustomRole, grantRolePermission } from "@/lib/authz/admin";
import { checkPermission } from "@/lib/authz/service";
import { loadSubject } from "@/lib/authz/subject";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";
import type { Subject } from "@/lib/authz/types";
import { createForum, updateForum } from "@/lib/forums/admin";
import { ManageApiError } from "@/lib/manage/errors";
import { runIdempotentManageWrite } from "@/lib/manage/idempotency";
import { makeActiveUser } from "@/lib/manage/int-fixtures";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  approveReview,
  disableContent,
  hidePost,
  listContentReviews,
  prepareApiReview,
  rejectReview,
} from "./review";
import { listContentsPage, loadContentDetail, prepareApiThreadLock } from "./contents";
import { createReply, createThread } from "@/lib/posting/service";
import { editPost } from "@/lib/posting/mutate";
import { lockUserStats } from "@/lib/locks";
import { POINTS_TX_OPTIONS } from "@/lib/points/retry";

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
async function seedPendingThread(
  forumId = REVIEW_FORUM,
): Promise<{ threadId: number; postId: number }> {
  const author = await loadSubject(DEMO.xiaoyi);
  const out = await createThread(
    author,
    { forumId, title: `待审 ${Date.now()}-${Math.random()}`, source: "待审正文" },
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

describe.skipIf(skipDb)("管理 API 审核业务", () => {
  const apiActor = { ...ACTOR, via: "api" as const };
  const trace = { requestId: "review-integration", tokenSuffix: "tail0001" };

  it("以详情版本审查真实编辑和重提，锁与实际执行分离，审计和 outbox 随事务提交", async () => {
    const { threadId, postId } = await seedPendingThread();
    const author = await loadSubject(DEMO.xiaoyi);
    async function version() {
      const detail = await loadContentDetail("thread", threadId, [REVIEW_FORUM]);
      if (!detail.ok || detail.detail.kind !== "thread") throw new Error("未找到主题详情");
      return detail.detail.firstPost.editedAt;
    }
    async function execute(decision: "approve" | "reject", expectedEditedAt: string | null) {
      const prepared = await prepareApiReview(
        admin,
        postId,
        { decision, expectedEditedAt, ...(decision === "reject" ? { reason: "  请修改  " } : {}) },
        apiActor,
        trace,
      );
      if (!prepared.ok) throw new Error(prepared.code);
      return db().transaction(async (tx) => {
        const locked = await prepared.lock(tx);
        if (!locked.ok) throw new Error(locked.code);
        return locked.execute();
      }, POINTS_TX_OPTIONS);
    }

    expect(await version()).toBeNull();
    const rejected = await execute("reject", null);
    expect(rejected).toMatchObject({ ok: true, data: { postId, threadId, state: "rejected" } });
    await expect(
      editPost(author, {
        postId,
        title: "审核重提新标题",
        source: "再次提交正文",
        expectedEditedAt: null,
      }),
    ).resolves.toMatchObject({ ok: true, state: "pending", resubmitted: true });
    const freshVersion = await version();
    expect(freshVersion).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(await execute("approve", null)).toMatchObject({ ok: false, code: "conflict" });
    expect(await postState(postId)).toBe("pending");

    const approved = await execute("approve", freshVersion);
    if (!approved.ok) throw new Error(approved.code);
    expect(approved.data).toEqual({ postId, threadId, state: "visible" });
    const [created] = await outboxOf("thread.created", { k: "postId", v: postId });
    expect(created.payload).toMatchObject({ title: "审核重提新标题" });
    expect(created.dispatchedAt).toBeNull();
    await approved.afterCommit?.();
    expect(
      (await outboxOf("thread.created", { k: "postId", v: postId }))[0].dispatchedAt,
    ).not.toBeNull();

    const replay = await prepareApiReview(
      admin,
      postId,
      { decision: "approve", expectedEditedAt: freshVersion },
      apiActor,
      trace,
    );
    if (!replay.ok) throw new Error(replay.code);
    await db().transaction(async (tx) => {
      const locked = await replay.lock(tx);
      expect(locked.ok).toBe(true);
    }, POINTS_TX_OPTIONS);
    expect(await listContentReviews(postId)).toMatchObject([
      { decision: "approved", note: "" },
      { decision: "rejected", note: "请修改" },
    ]);
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetType, "post"), eq(auditLog.targetId, String(postId))))
      .orderBy(desc(auditLog.id));
    expect(audits.filter((row) => row.action.startsWith("post.state."))).toMatchObject([
      {
        actorId: DEMO.admin,
        beforeJson: { state: "pending" },
        afterJson: {
          state: "visible",
          kind: "thread",
          threadId,
          reason: null,
          via: "api",
          ...trace,
        },
      },
      {
        actorId: DEMO.admin,
        beforeJson: { state: "pending" },
        afterJson: {
          state: "rejected",
          kind: "thread",
          threadId,
          reason: "请修改",
          via: "api",
          ...trace,
        },
      },
    ]);
  });

  it("旧事务快照下同 ID 版块迁出授权父级，拒绝新审核、锁帖与实际幂等回放", async () => {
    const parentId = 900;
    const forumInput = {
      parentId,
      kind: "forum" as const,
      name: "父级授权审核夹具",
      description: null,
      sortOrder: 0,
      isListed: true,
    };
    const forum = await createForum(ACTOR, forumInput);
    if (!forum.ok) throw new Error(forum.code);
    const forumId = forum.id;
    const settings = {
      ...forumInput,
      readPolicy: "inherit" as const,
      writePolicy: "inherit" as const,
      reviewPolicy: "all" as const,
      isArchived: false,
    };
    expect(await updateForum(ACTOR, forumId, settings)).toEqual({ ok: true });
    const roleKey = "review-parent-moderator";
    await createCustomRole(ACTOR, roleKey, "父级授权版主", "");
    await grantRolePermission(ACTOR, roleKey, "forum.moderate", parentId);
    const moderatorId = await makeActiveUser("review_parent_moderator");
    await assignUserRole(ACTOR, moderatorId, roleKey, 0, null, "继承权限回归夹具");
    const subject = await loadSubject(moderatorId);
    expect((await checkPermission(subject, "site.admin")).allowed).toBe(false);
    expect((await checkPermission(subject, "forum.moderate", { forumId })).allowed).toBe(true);

    const done = await seedPendingThread(forumId);
    const pending = await seedPendingThread(forumId);
    const actor = { ...apiActor, userId: moderatorId };
    const input = { decision: "approve", expectedEditedAt: null } as const;
    const replay = await prepareApiReview(subject, done.postId, input, actor, trace);
    const newReview = await prepareApiReview(subject, pending.postId, input, actor, trace);
    const lock = await prepareApiThreadLock(subject, pending.threadId, true, actor, trace);
    if (!replay.ok || !newReview.ok || !lock.ok) throw new Error("无法准备治理操作");
    const identity = {
      tokenId: "a".repeat(64),
      endpoint: "posts.review" as const,
      idempotencyKey: "parent-scope-replay-key",
      requestId: trace.requestId,
    };
    const applyReview = (move = false) =>
      runIdempotentManageWrite(identity, done.postId, input, async (tx) => {
        if (move) {
          const readParent = async () =>
            (
              await tx
                .select({ parentId: forums.parentId })
                .from(forums)
                .where(eq(forums.id, forumId))
            )[0]?.parentId;
          expect(await readParent()).toBe(parentId);
          // 第二条连接在当前事务的可重复读视图建立后，通过真实管理服务迁版并提交。
          expect(await updateForum(ACTOR, forumId, { ...settings, parentId: 0 })).toEqual({
            ok: true,
          });
          expect(await readParent()).toBe(parentId);
        }
        const target = await replay.lock(tx);
        if (!target.ok) throw new ManageApiError("not_found");
        return async () => {
          const result = await target.execute();
          if (!result.ok) throw new Error(result.code);
          return result;
        };
      });
    expect(await applyReview()).toEqual({
      postId: done.postId,
      threadId: done.threadId,
      state: "visible",
    });
    const readReplay = () =>
      db()
        .select()
        .from(manageApiIdempotency)
        .where(eq(manageApiIdempotency.tokenId, identity.tokenId));
    const cached = await readReplay();
    expect(cached).toHaveLength(1);
    await expect(applyReview(true)).rejects.toMatchObject({ code: "not_found" });
    const missingReview = await prepareApiReview(subject, 99_999_999, input, actor, trace);
    const missingLock = await prepareApiThreadLock(subject, 99_999_999, true, actor, trace);
    expect(missingReview).toMatchObject({ ok: false, code: "not_found" });
    expect(missingLock).toMatchObject({ ok: false, code: "not_found" });
    expect(await db().transaction((tx) => newReview.lock(tx))).toEqual(missingReview);
    expect(await db().transaction((tx) => lock.lock(tx))).toEqual(missingLock);
    expect(await readReplay()).toEqual(cached);
    expect(await postState(pending.postId)).toBe("pending");
    expect(await listContentReviews(pending.postId)).toHaveLength(0);
    expect(await listContentReviews(done.postId)).toHaveLength(1);
    expect(await outboxOf("content.moderated", { k: "postId", v: pending.postId })).toHaveLength(0);
    expect(await outboxOf("content.moderated", { k: "postId", v: done.postId })).toHaveLength(1);
    expect(await loadContentDetail("thread", pending.threadId, null)).toMatchObject({
      ok: true,
      detail: { forumId, isLocked: false },
    });
  });

  it("调用方回滚时状态、审核历史、审计和 outbox 均不提交", async () => {
    const { postId } = await seedPendingThread();
    const prepared = await prepareApiReview(
      admin,
      postId,
      { decision: "approve", expectedEditedAt: null },
      apiActor,
      trace,
    );
    if (!prepared.ok) throw new Error(prepared.code);
    await expect(
      db().transaction(async (tx) => {
        const locked = await prepared.lock(tx);
        if (!locked.ok) throw new Error(locked.code);
        expect((await locked.execute()).ok).toBe(true);
        throw new Error("回滚本次操作");
      }, POINTS_TX_OPTIONS),
    ).rejects.toThrow("回滚本次操作");
    expect(await postState(postId)).toBe("pending");
    expect(await listContentReviews(postId)).toEqual([]);
    expect(await outboxOf("content.moderated", { k: "postId", v: postId })).toEqual([]);
    expect(
      await db()
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, "post.state.visible"), eq(auditLog.targetId, String(postId))),
        ),
    ).toEqual([]);
  });
});

describe.skipIf(skipDb)("审核动作（M9）", () => {
  it("approve：pending→visible、content_reviews 落行、补发 thread.created、计数就位、作者积分入账", async () => {
    const { threadId, postId } = await seedPendingThread();
    expect(await postState(postId)).toBe("pending");

    // 队列里可见（M19 起队列语义由 contents 承载：待审先到先审正序）
    const queue = await listContentsPage({
      kind: "thread",
      state: "pending",
      scopeForumIds: null,
      page: 1,
      order: "queue",
    });
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

  it("真实编辑重提后第二轮驳回独立通知，补派不重发各轮", async () => {
    const { postId } = await seedPendingThread();
    expect(await rejectReview(admin, postId, "第一轮：缺少引用", ACTOR)).toMatchObject({
      ok: true,
    });
    const author = await loadSubject(DEMO.xiaoyi);
    expect(
      await editPost(author, {
        postId,
        title: "补充引用后重提",
        source: "回填的正文",
        expectedEditedAt: null,
      }),
    ).toMatchObject({ ok: true, resubmitted: true });
    expect(await rejectReview(admin, postId, "第二轮：请补署名", ACTOR)).toMatchObject({
      ok: true,
    });

    const rows = await outboxOf("content.moderated", { k: "postId", v: postId });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.deliveryPolicy === "moderation_notification_v1")).toBe(true);
    async function reasons() {
      const result = await db()
        .select({ data: notifications.data })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, DEMO.xiaoyi),
            eq(notifications.type, "content.rejected"),
            eq(notifications.targetId, postId),
          ),
        )
        .orderBy(notifications.id);
      return result.map((row) => (row.data as { reason?: string } | null)?.reason);
    }
    const expected = ["第一轮：缺少引用", "第二轮：请补署名"];
    expect(await reasons()).toEqual(expected);
    for (const row of rows) {
      await db().update(eventOutbox).set({ dispatchedAt: null }).where(eq(eventOutbox.id, row.id));
    }
    await outbox.drainOutbox();
    expect(await reasons()).toEqual(expected);
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

    const removed = await listContentsPage({
      kind: "thread",
      state: "hidden",
      scopeForumIds: null,
      page: 1,
    });
    expect(removed.items.some((i) => i.postId === postId)).toBe(true);
    expect(
      (
        await listContentsPage({
          kind: "thread",
          state: "pending",
          scopeForumIds: null,
          page: 1,
          order: "queue",
        })
      ).items.some((i) => i.postId === postId),
    ).toBe(false); // hidden 不在待审队列
  });

  it.each([
    { name: "待审队列正序（order=queue）", state: "pending" as const, order: "queue" as const },
    { name: "已删除倒序（默认 recent）", state: "deleted" as const, order: undefined },
  ])(
    "同时间戳分页：contents $name——按 createdAt/id 同向排序且跨页无漏行",
    async ({ state, order }) => {
      const [forum] = await db()
        .insert(forums)
        .values({ name: `contents 同秒-${state}`, readPolicy: "public" });
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
          title: `同秒-${state}`,
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
        const [reply] = await db().insert(posts).values({
          threadId,
          authorId: DEMO.member,
          floor,
          bodyMd: "同秒回帖",
          state,
          createdAt: "2026-05-01 10:00:00",
        });
        expectedIds.push(Number(reply.insertId));
      }
      const ids: number[] = [];
      for (let page = 1; page <= 5; page++) {
        const result = await listContentsPage({
          kind: "reply",
          state,
          forumId,
          scopeForumIds: null,
          page,
          perPage: 5,
          ...(order ? { order } : {}),
        });
        expect(result.total).toBe(23);
        expect(result.totalPages).toBe(5);
        ids.push(...result.items.map((item) => item.postId));
      }
      expect(new Set(ids).size).toBe(23);
      expect(ids).toEqual(order === "queue" ? expectedIds : expectedIds.toReversed());
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
