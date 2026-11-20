import { createHash, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { USERS, loginAs } from "./support/session";
import { withE2eDb, type Q } from "./support/db";
import { FIX } from "./support/fixtures";
import {
  WRITE_ENDPOINTS,
  bearer,
  cleanupManageArtifacts,
  createAdminUser,
  createAuthorUser,
  expectManageError,
  expectOpsPipelineDisconnected,
  fillEndpointPath,
  insertLegacyToken,
  issueManageToken,
  revokeManageToken,
  runTag,
  seedPendingThread,
  type ManageDomain,
  type ManageLevel,
  type PendingThread,
} from "./support/manage-api";

/**
 * 管理 REST 写链路、真实查询数据与凭证生命周期验收。
 *
 * 权限档位与端点矩阵由 manage-api-matrix.spec.ts 系统化覆盖；本文件核对独立夹具的实际查询值、
 * 写入后的状态与副作用、幂等与冲突行为，以及凭证吊销、过期和实时权限裁剪。
 */

const TAG = runTag();
const NAME_PREFIX = `E2E REST 验收 · ${TAG} · `;

const SHARED_REVIEW_FORUM_ID = 906;
const CONTENT_FORUM_NAME = `REST 审核夹具 ${TAG}`;
const tokenNames: string[] = [];
const adminUserIds: number[] = [];
const authorUserIds: number[] = [];
const targets: PendingThread[] = [];
let contentForumId = 0;
let sharedForumBefore: Awaited<ReturnType<typeof forumDerived>> | undefined;

/** 读取版块完整派生值，不写入共享夹具。 */
function forumDerived(q: Q, forumId: number) {
  return q.query<{
    threadCount: number;
    postCount: number;
    lastPostId: number | null;
    lastPostedAt: string | null;
  }>(
    `SELECT thread_count AS threadCount, post_count AS postCount,
            last_post_id AS lastPostId, last_posted_at AS lastPostedAt FROM forums WHERE id = ?`,
    [forumId],
  );
}

/** 用隔离版块及专属作者造首帖，逐步登记主键，以便中途失败也能回收。 */
async function seedContentThread(
  tag: string,
  state: "pending" | "deleted" | "visible" = "pending",
) {
  const target: PendingThread = { threadId: 0, postId: 0 };
  targets.push(target);
  return withE2eDb(async (q) => {
    const authorId = await createAuthorUser(q, tag);
    authorUserIds.push(authorId);
    await seedPendingThread(q, target, authorId, tag, state, contentForumId);
    return { target, authorId };
  });
}

/** 验证迁移确实写入专属版块的可见计数和最后一帖，而不是绕开派生写入。 */
async function expectVisibleForumThread(
  target: PendingThread,
  before: Awaited<ReturnType<typeof forumDerived>>,
) {
  await withE2eDb(async (q) => {
    const [post] = await q.query<{ createdAt: string }>(
      "SELECT created_at AS createdAt FROM posts WHERE id = ?",
      [target.postId],
    );
    expect(await forumDerived(q, contentForumId)).toEqual([
      {
        threadCount: before[0].threadCount + 1,
        postCount: before[0].postCount + 1,
        lastPostId: target.postId,
        lastPostedAt: post.createdAt,
      },
    ]);
  });
}

/**
 * 为单个写语义用例签发独立管理员与写令牌：写频控按令牌 10 次/分钟计，
 * 共享令牌会在多用例累计后触发 429，因此每个重度写用例独占一枚。
 */
async function issueWriterToken(
  page: Page,
  tag: string,
  levels: Partial<Record<ManageDomain, ManageLevel>> = {
    contents: "write",
    identity: "read",
  },
) {
  const adminId = await withE2eDb((q) => createAdminUser(q, `${TAG}-${tag}`));
  adminUserIds.push(adminId);
  const name = `${NAME_PREFIX}writer · ${tag}`;
  tokenNames.push(name);
  return issueManageToken(page, name, levels, adminId);
}

/** 用有效格式的写请求核对凭证或授权门禁的拒绝。 */
async function expectWriteDenied(
  request: APIRequestContext,
  token: string,
  code: "forbidden" | "unauthorized" = "forbidden",
) {
  const endpoint = WRITE_ENDPOINTS[0];
  const response = await request.fetch(fillEndpointPath(endpoint.path), {
    method: endpoint.method,
    headers: { ...bearer(token), "Idempotency-Key": randomUUID() },
    data: endpoint.sampleBody,
  });
  await expectManageError(response, code === "forbidden" ? 403 : 401, code);
}

test.describe.serial("管理 REST 全面验收", () => {
  test.beforeAll(async ({ browser, baseURL, request }) => {
    sharedForumBefore = await withE2eDb((q) => forumDerived(q, SHARED_REVIEW_FORUM_ID));
    expect(sharedForumBefore).toHaveLength(1);
    // 走管理 API 建版块，让服务端权限快照即时生效，不依赖其他规格刷新缓存。
    const page = await browser.newPage({ baseURL });
    try {
      const token = await issueWriterToken(page, "审核版块夹具", { forums: "write" });
      const fields = {
        parentId: 900,
        name: CONTENT_FORUM_NAME,
        description: null,
        sortOrder: 0,
        isListed: false,
      };
      const headers = () => ({ ...bearer(token), "Idempotency-Key": randomUUID() });
      const created = await request.post("/api/manage/forums", {
        headers: headers(),
        data: { ...fields, kind: "forum" },
      });
      expect(created.status(), await created.text()).toBe(200);
      contentForumId = ((await created.json()) as { data: { id: number } }).data.id;
      expect(contentForumId).not.toBe(SHARED_REVIEW_FORUM_ID);
      const configured = await request.patch(`/api/manage/forums/${contentForumId}`, {
        headers: headers(),
        data: {
          ...fields,
          readPolicy: "members",
          writePolicy: "restricted",
          reviewPolicy: "all",
          isArchived: false,
        },
      });
      expect(configured.status(), await configured.text()).toBe(200);
    } finally {
      await page.close();
    }
  });

  test.afterAll(async () => {
    try {
      await cleanupManageArtifacts({
        tokenNames,
        adminUserIds: [],
        temporaryAdminUserIds: adminUserIds,
        authorUserIds,
        targets,
        forumNames: [CONTENT_FORUM_NAME],
      });
    } finally {
      if (sharedForumBefore) {
        expect(
          await withE2eDb((q) => forumDerived(q, SHARED_REVIEW_FORUM_ID)),
          "验收退出后，共用审核版块的主题数、帖数、最后一帖及时间必须原样保留",
        ).toEqual(sharedForumBefore);
      }
    }
  });

  test("审核通过：版本冲突不改数据，通过后留痕、通知和发帖奖励各一条", async ({
    page,
    request,
  }) => {
    const writer = await issueWriterToken(page, "审核通过");
    const tag = `${TAG}-approve`;
    const { target, authorId } = await seedContentThread(tag);
    const before = await withE2eDb((q) => forumDerived(q, contentForumId));

    const detail = await request.get(`/api/manage/contents/${target.threadId}?kind=thread`, {
      headers: bearer(writer),
    });
    const { data } = (await detail.json()) as { data: { firstPost: { editedAt: string } } };
    const { editedAt } = data.firstPost;

    const conflicts = await request.post(`/api/manage/posts/${target.postId}/review`, {
      headers: { ...bearer(writer), "Idempotency-Key": randomUUID() },
      data: { decision: "approve", expectedEditedAt: null },
    });
    await expectManageError(conflicts, 409, "state_conflict");
    expect(
      await withE2eDb((q) =>
        q.query("SELECT id FROM audit_log WHERE target_type = 'post' AND target_id = ?", [
          String(target.postId),
        ]),
      ),
      "版本冲突不得写变更审计",
    ).toEqual([]);
    expect(
      await withE2eDb((q) => q.query("SELECT id FROM notifications WHERE user_id = ?", [authorId])),
      "版本冲突不得发通知",
    ).toEqual([]);

    const accepted = await request.post(`/api/manage/posts/${target.postId}/review`, {
      headers: { ...bearer(writer), "Idempotency-Key": randomUUID() },
      data: { decision: "approve", expectedEditedAt: editedAt },
    });
    expect(accepted.status()).toBe(200);
    expect(await accepted.json()).toEqual({
      ok: true,
      data: { postId: target.postId, threadId: target.threadId, state: "visible" },
    });

    const state = await withE2eDb((q) =>
      q.query<{ state: string }>("SELECT state FROM posts WHERE id = ?", [target.postId]),
    );
    expect(state).toEqual([{ state: "visible" }]);
    const audits = await withE2eDb((q) =>
      q.query<{ action: string; via: string }>(
        "SELECT action, JSON_UNQUOTE(JSON_EXTRACT(after_json, '$.via')) AS via FROM audit_log WHERE target_type = 'post' AND target_id = ?",
        [String(target.postId)],
      ),
    );
    expect(audits).toEqual([{ action: "post.state.visible", via: "api" }]);
    await expectVisibleForumThread(target, before);
    await withE2eDb(async (q) => {
      const events = await q.query<{ id: number; eventName: string }>(
        `SELECT id, event_name AS eventName, dispatched_at AS dispatchedAt, dispatch_error AS error
         FROM event_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.postId')) = ? ORDER BY id`,
        [String(target.postId)],
      );
      const dispatched = { id: expect.any(Number), dispatchedAt: expect.any(String), error: null };
      expect(events).toEqual([
        { ...dispatched, eventName: "thread.created" },
        { ...dispatched, eventName: "content.moderated" },
      ]);
      expect(
        await q.query(
          `SELECT event_name AS eventName, error_json AS error FROM event_log
         WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.postId')) = ? ORDER BY id`,
          [String(target.postId)],
        ),
      ).toEqual([
        { eventName: "thread.created", error: null },
        { eventName: "content.moderated", error: null },
      ]);
      expect(
        await q.query(
          "SELECT type, user_id AS userId FROM notification_receipts WHERE outbox_id = ?",
          [events[1].id],
        ),
      ).toEqual([{ type: "content.approved", userId: authorId }]);
      expect(await q.query("SELECT type FROM notifications WHERE user_id = ?", [authorId])).toEqual(
        [{ type: "content.approved" }],
      );
      const earned = await q.query<{ delta: number }>(
        `SELECT channel, delta, ref_type AS refType, ref_id AS refId, idempotency_key AS idempotencyKey
         FROM point_ledger WHERE user_id = ?`,
        [authorId],
      );
      expect(earned).toEqual([
        {
          channel: "earn.post",
          delta: expect.any(Number),
          refType: "thread",
          refId: target.threadId,
          idempotencyKey: `thread:${target.threadId}`,
        },
      ]);
      expect(earned[0].delta).toBeGreaterThan(0);
      expect(
        await q.query("SELECT balance FROM point_accounts WHERE user_id = ?", [authorId]),
      ).toEqual([{ balance: earned[0].delta }]);
      expect(
        await q.query(
          "SELECT error_json AS error FROM event_log WHERE event_name = 'points.changed' AND actor_id = ?",
          [authorId],
        ),
      ).toEqual([{ error: null }]);
    });
  });

  test("驳回：理由送达，同键回放与异参冲突都不重复副作用", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "驳回：理由送");
    const { target, authorId } = await seedContentThread(`${TAG}-reject`);

    const detail = await request.get(`/api/manage/contents/${target.threadId}?kind=thread`, {
      headers: bearer(writer),
    });
    const { data } = (await detail.json()) as { data: { firstPost: { editedAt: string } } };
    const key = randomUUID();
    const reason = "需要补充引用来源";
    const review = (body: unknown, idempotencyKey = key) =>
      request.post(`/api/manage/posts/${target.postId}/review`, {
        headers: { ...bearer(writer), "Idempotency-Key": idempotencyKey },
        data: body,
      });

    const first = await review({
      decision: "reject",
      reason,
      expectedEditedAt: data.firstPost.editedAt,
    });
    expect(first.status()).toBe(200);
    const accepted = {
      ok: true,
      data: { postId: target.postId, threadId: target.threadId, state: "rejected" },
    };
    expect(await first.json()).toEqual(accepted);

    const notices = await withE2eDb((q) =>
      q.query<{ type: string; reason: string }>(
        "SELECT type, JSON_UNQUOTE(JSON_EXTRACT(data, '$.reason')) AS reason FROM notifications WHERE user_id = ?",
        [authorId],
      ),
    );
    expect(notices).toEqual([{ type: "content.rejected", reason }]);

    const replay = await review({
      decision: "reject",
      reason,
      expectedEditedAt: data.firstPost.editedAt,
    });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(accepted);
    expect(
      await withE2eDb((q) => q.query("SELECT id FROM notifications WHERE user_id = ?", [authorId])),
      "同键回放不得重复通知",
    ).toHaveLength(1);
    expect(
      await withE2eDb((q) =>
        q.query("SELECT id FROM content_reviews WHERE post_id = ?", [target.postId]),
      ),
      "同键回放不得重复审核记录",
    ).toHaveLength(1);

    const conflict = await review({
      decision: "reject",
      reason: "另一个理由",
      expectedEditedAt: data.firstPost.editedAt,
    });
    await expectManageError(conflict, 409, "idempotency_conflict");
    expect(
      await withE2eDb((q) => q.query("SELECT id FROM notifications WHERE user_id = ?", [authorId])),
      "异参冲突不得改变既有通知",
    ).toHaveLength(1);
  });

  test("锁定与解锁：同值零审计，反向变更留痕", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "锁定与解锁：");
    const { target } = await seedContentThread(`${TAG}-lock`);

    const lock = (locked: boolean, key = randomUUID()) =>
      request.put(`/api/manage/threads/${target.threadId}/lock`, {
        headers: { ...bearer(writer), "Idempotency-Key": key },
        data: { locked },
      });
    const audits = () =>
      withE2eDb((q) =>
        q.query<{ action: string }>(
          "SELECT action FROM audit_log WHERE target_type = 'thread' AND target_id = ?",
          [String(target.threadId)],
        ),
      );

    const locked = await lock(true);
    expect(locked.status()).toBe(200);
    expect(await locked.json()).toEqual({
      ok: true,
      data: { threadId: target.threadId, locked: true, changed: true },
    });
    expect(await audits()).toEqual([{ action: "admin.thread.flags" }]);

    const same = await lock(true);
    expect(same.status()).toBe(200);
    expect(await same.json()).toEqual({
      ok: true,
      data: { threadId: target.threadId, locked: true, changed: false },
    });
    expect(await audits(), "同值锁定不得重复写审计").toHaveLength(1);

    const unlocked = await lock(false);
    expect(unlocked.status()).toBe(200);
    expect(await unlocked.json()).toEqual({
      ok: true,
      data: { threadId: target.threadId, locked: false, changed: true },
    });
    expect(await audits()).toHaveLength(2);
  });

  test("凭证失效：吊销与过期后读写一律 401", async ({ page, request }) => {
    const adminId = await withE2eDb((q) => createAdminUser(q, `${TAG}-credential`));
    adminUserIds.push(adminId);
    const name = `${NAME_PREFIX}待吊销`;
    tokenNames.push(name, `${name}-历史`);
    const token = await issueManageToken(
      page,
      name,
      { contents: "write", identity: "read" },
      adminId,
    );
    const legacy = await withE2eDb((q) => insertLegacyToken(q, adminId, `${name}-历史`));

    expect((await request.get("/api/manage/whoami", { headers: bearer(token) })).status()).toBe(
      200,
    );
    // 历史令牌只保留九个 GET，写端点一律拒绝。
    expect((await request.get("/api/manage/whoami", { headers: bearer(legacy) })).status()).toBe(
      200,
    );
    await expectWriteDenied(request, legacy);

    await revokeManageToken(page, name);
    await expectManageError(
      await request.get("/api/manage/whoami", { headers: bearer(token) }),
      401,
      "unauthorized",
    );
    await expectWriteDenied(request, token, "unauthorized");

    const expiredName = `${name}-过期`;
    tokenNames.push(expiredName);
    const expired = await issueManageToken(page, expiredName, {
      contents: "write",
      identity: "read",
    });
    const expiration = await withE2eDb((q) =>
      q.exec("UPDATE admin_api_tokens SET expires_at = NOW() - INTERVAL 1 SECOND WHERE id = ?", [
        createHash("sha256").update(expired).digest("hex"),
      ]),
    );
    expect(expiration.affectedRows).toBe(1);
    await expectManageError(
      await request.get("/api/manage/whoami", { headers: bearer(expired) }),
      401,
      "unauthorized",
    );
    await expectWriteDenied(request, expired, "unauthorized");
  });

  test("屏蔽与封禁：状态机迁移与恢复冲突", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "屏蔽与封禁：");
    // 屏蔽要求 visible 起点；版本号从内容详情取得（与审核同口径）。
    const { target } = await seedContentThread(`${TAG}-hide`, "visible");
    const detail = await request.get(`/api/manage/contents/${target.threadId}?kind=thread`, {
      headers: bearer(writer),
    });
    const { data } = (await detail.json()) as { data: { firstPost: { editedAt: string } } };
    const { editedAt } = data.firstPost;

    const hide = (key = randomUUID()) =>
      request.post(`/api/manage/posts/${target.postId}/hide`, {
        headers: { ...bearer(writer), "Idempotency-Key": key },
        data: { expectedEditedAt: editedAt, reason: "违规内容" },
      });
    const disable = (key = randomUUID()) =>
      request.post(`/api/manage/posts/${target.postId}/disable`, {
        headers: { ...bearer(writer), "Idempotency-Key": key },
        data: { expectedEditedAt: editedAt, reason: "严重违规" },
      });
    const restore = (key = randomUUID()) =>
      request.post(`/api/manage/posts/${target.postId}/restore`, {
        headers: { ...bearer(writer), "Idempotency-Key": key },
        data: { expectedEditedAt: editedAt },
      });

    const hidden = await hide();
    expect(hidden.status()).toBe(200);
    expect(await hidden.json()).toEqual({
      ok: true,
      data: { postId: target.postId, threadId: target.threadId, state: "hidden" },
    });
    // 已屏蔽再屏蔽 → 409。
    await expectManageError(await hide(), 409, "state_conflict");

    // hidden → disabled 允许；disabled → deleted 之外不可恢复。
    const disabled = await disable();
    expect(disabled.status()).toBe(200);
    expect(await disabled.json()).toMatchObject({ data: { state: "disabled" } });
    await expectManageError(await restore(), 409, "state_conflict");

    const states = await withE2eDb((q) =>
      q.query<{ action: string }>(
        "SELECT action FROM audit_log WHERE target_type = 'post' AND target_id = ? ORDER BY id",
        [String(target.postId)],
      ),
    );
    expect(states.map((row) => row.action)).toEqual(["post.state.hidden", "post.state.disabled"]);
  });

  test("恢复：已删内容经 API 恢复为可见，同键回放不重复", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "恢复：已删内");
    const { target, authorId } = await seedContentThread(`${TAG}-restore`, "deleted");
    const before = await withE2eDb((q) => forumDerived(q, contentForumId));
    const detail = await request.get(`/api/manage/contents/${target.threadId}?kind=thread`, {
      headers: bearer(writer),
    });
    const { data } = (await detail.json()) as { data: { firstPost: { editedAt: string } } };

    const restoreKey = randomUUID();
    const restore = () =>
      request.post(`/api/manage/posts/${target.postId}/restore`, {
        headers: { ...bearer(writer), "Idempotency-Key": restoreKey },
        data: { expectedEditedAt: data.firstPost.editedAt },
      });
    const restored = await restore();
    expect(restored.status(), JSON.stringify(await restored.json())).toBe(200);
    const accepted = {
      ok: true,
      data: { postId: target.postId, threadId: target.threadId, state: "visible" },
    };
    expect(await restored.json()).toEqual(accepted);
    const replay = await restore();
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(accepted);
    const audits = await withE2eDb((q) =>
      q.query<{ action: string }>(
        "SELECT action FROM audit_log WHERE target_type = 'post' AND target_id = ?",
        [String(target.postId)],
      ),
    );
    expect(audits).toEqual([{ action: "post.state.visible" }]);
    await expectVisibleForumThread(target, before);
    await withE2eDb(async (q) => {
      expect(
        await q.query(
          `SELECT event_name AS eventName, dispatched_at AS dispatchedAt, dispatch_error AS error
         FROM event_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.postId')) = ?`,
          [String(target.postId)],
        ),
      ).toEqual([
        { eventName: "content.moderated", dispatchedAt: expect.any(String), error: null },
      ]);
      expect(
        await q.query(
          "SELECT type, target_id AS targetId FROM notifications WHERE user_id = ? AND target_type = 'post'",
          [authorId],
        ),
      ).toEqual([{ type: "content.restored", targetId: target.postId }]);
    });
  });

  test("主题标记：精华与置顶留痕，同值零审计", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "主题标记：精");
    const { target } = await seedContentThread(`${TAG}-flags`, "visible");

    const flags = (body: Record<string, unknown>, key = randomUUID()) =>
      request.patch(`/api/manage/threads/${target.threadId}/flags`, {
        headers: { ...bearer(writer), "Idempotency-Key": key },
        data: body,
      });

    const featured = await flags({ featured: true });
    expect(featured.status()).toBe(200);
    expect(await featured.json()).toEqual({
      ok: true,
      data: { threadId: target.threadId, changed: true, featured: true },
    });
    // 同值再设（新键）：changed=false 且不重复写审计。
    const same = await flags({ featured: true });
    expect(await same.json()).toMatchObject({ data: { changed: false } });
    const pinned = await flags({ pinLevel: 1 });
    expect(await pinned.json()).toMatchObject({ data: { changed: true, pinLevel: 1 } });
    const audits = await withE2eDb((q) =>
      q.query<{ action: string }>(
        "SELECT action FROM audit_log WHERE target_type = 'thread' AND target_id = ?",
        [String(target.threadId)],
      ),
    );
    expect(audits).toHaveLength(2);
    const detail = await request.get(`/api/manage/contents/${target.threadId}?kind=thread`, {
      headers: bearer(writer),
    });
    expect(await detail.json()).toMatchObject({ data: { isFeatured: true, pinLevel: 1 } });
  });

  test("举报：处置状态机、幂等回放与列表详情", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "举报：处置状", {
      reports: "write",
      identity: "read",
    });
    // 处置人是本用例专用管理员（规避写频控跨用例累计），经 whoami 取其 ID 断言落账
    const who = await request.get("/api/manage/whoami", { headers: bearer(writer) });
    expect(who.status()).toBe(200);
    const writerAdminId = ((await who.json()) as { data: { user: { id: number } } }).data.user.id;
    // 举报列表查询只展示可见内容上的举报：目标帖用可见态。
    const { target } = await seedContentThread(`${TAG}-report`, "visible");
    const reporterId = await withE2eDb((q) => createAuthorUser(q, `${TAG}-report-reporter`));
    authorUserIds.push(reporterId);
    const reportId = (
      await withE2eDb((q) =>
        q.exec(
          `INSERT INTO reports (post_id, reporter_id, reason, status, created_at)
           VALUES (?, ?, '垃圾广告', 'pending', NOW())`,
          [target.postId, reporterId],
        ),
      )
    ).insertId;

    const list = await request.get("/api/manage/reports?status=pending&size=10", {
      headers: bearer(writer),
    });
    expect(list.status()).toBe(200);
    const listed = (await list.json()) as { data: { items: { id: number }[] } };
    expect(
      listed.data.items.some((i) => i.id === reportId),
      `举报 ${reportId} 未在 pending 列表：${JSON.stringify(listed.data)}`,
    ).toBe(true);
    const detail = await request.get(`/api/manage/reports/${reportId}`, {
      headers: bearer(writer),
    });
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({
      data: { id: reportId, status: "pending", reason: "垃圾广告" },
    });

    const key = randomUUID();
    const resolve = await request.post(`/api/manage/reports/${reportId}/resolve`, {
      headers: { ...bearer(writer), "Idempotency-Key": key },
      data: { note: "已确认并处理" },
    });
    expect(resolve.status()).toBe(200);
    expect(await resolve.json()).toEqual({
      ok: true,
      data: { reportId, decision: "resolved" },
    });
    // 同键回放返回同一结果，不重复通知举报人。
    const replay = await request.post(`/api/manage/reports/${reportId}/resolve`, {
      headers: { ...bearer(writer), "Idempotency-Key": key },
      data: { note: "已确认并处理" },
    });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual({
      ok: true,
      data: { reportId, decision: "resolved" },
    });

    // 已处置的报告不能再忽略（状态机 → 409）；同键换端点属新意图，同样撞状态机。
    const dismiss = await request.post(`/api/manage/reports/${reportId}/dismiss`, {
      headers: { ...bearer(writer), "Idempotency-Key": randomUUID() },
      data: { note: "误报" },
    });
    await expectManageError(dismiss, 409, "state_conflict");

    const row = await withE2eDb((q) =>
      q.query<{ status: string; note: string; handledBy: number }>(
        "SELECT status, handled_note AS note, handled_by AS handledBy FROM reports WHERE id = ?",
        [reportId],
      ),
    );
    expect(row).toEqual([{ status: "resolved", note: "已确认并处理", handledBy: writerAdminId }]);
    const notices = await withE2eDb((q) =>
      q.query("SELECT id FROM notifications WHERE user_id = ?", [reporterId]),
    );
    expect(notices).toHaveLength(1);
    // 清理本次举报行（举报人通知由共享清理按 authorUserIds 回收）。
    await withE2eDb((q) => q.exec("DELETE FROM reports WHERE id = ?", [reportId]));
  });

  test("用户限制：入参校验、幂等回放、重复拒绝与解除留痕", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "用户限制：入", { users: "write" });
    const authorId = await withE2eDb((q) => createAuthorUser(q, `${TAG}-restrict`));
    authorUserIds.push(authorId);
    const restrictPath = `/api/manage/users/${authorId}/restrictions`;
    const post = (data: Record<string, unknown>, key = randomUUID()) =>
      request.post(restrictPath, {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data,
      });

    // 入参在信封层 400：非法 kind / scope 配对错误 / 过期时间非未来
    await expectManageError(
      await post({ kind: "banned", reason: "x", endsAt: null }),
      400,
      "bad_request",
    );
    await expectManageError(
      await post({ kind: "ban", reason: "x", endsAt: null, scopeId: 951001 }),
      400,
      "bad_request",
    );
    await expectManageError(
      await post({ kind: "mute", reason: "x", endsAt: "2020-01-01 00:00:00" }),
      400,
      "bad_request",
    );

    // 创建禁言（未来到期）：落账 + 同键回放同响应 + 新键撞已有限制 409
    const key = randomUUID();
    const muteData = { kind: "mute", reason: "刷屏测试", endsAt: "2027-01-01 08:00:00" };
    const mute = await post(muteData, key);
    expect(mute.status()).toBe(200);
    expect(await mute.json()).toEqual({
      ok: true,
      data: { userId: authorId, kind: "mute", scopeId: 0, endsAt: "2027-01-01 08:00:00" },
    });
    const replay = await post(muteData, key);
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual({
      ok: true,
      data: { userId: authorId, kind: "mute", scopeId: 0, endsAt: "2027-01-01 08:00:00" },
    });
    await expectManageError(
      await post({ kind: "mute", reason: "重复", endsAt: "2027-01-01 08:00:00" }),
      409,
      "state_conflict",
    );

    const [restriction] = await withE2eDb((q) =>
      q.query<{ id: number }>("SELECT id FROM user_restrictions WHERE user_id = ?", [authorId]),
    );
    const liftPath = `${restrictPath}/${restriction.id}`;
    const lift = (key2 = randomUUID()) =>
      request.delete(liftPath, {
        headers: { ...bearer(writer), "Idempotency-Key": key2, "content-type": "application/json" },
        data: { note: "已改正" },
      });
    // 解除：endsAt 提前；再次解除（已过期）→ 409
    expect((await lift()).status()).toBe(200);
    await expectManageError(await lift(), 409, "state_conflict");
    const [row] = await withE2eDb((q) =>
      q.query<{ endsAt: string }>("SELECT ends_at AS endsAt FROM user_restrictions WHERE id = ?", [
        restriction.id,
      ]),
    );
    expect(row.endsAt).not.toBe("2027-01-01 08:00:00");
    // 被限制人收到 restricted 与 lifted 两条强制通知
    const notices = await withE2eDb((q) =>
      q.query<{ type: string }>(
        "SELECT type FROM notifications WHERE user_id = ? AND type IN ('account.restricted','account.restriction_lifted')",
        [authorId],
      ),
    );
    expect(notices.map((n) => n.type).sort()).toEqual([
      "account.restricted",
      "account.restriction_lifted",
    ]);
    await withE2eDb((q) => q.exec("DELETE FROM user_restrictions WHERE user_id = ?", [authorId]));
  });

  test("全站封禁：同事务吊销全部会话，回放与重复拒绝", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "全站封禁：同", { users: "write" });
    const authorId = await withE2eDb((q) => createAuthorUser(q, `${TAG}-globalban`));
    authorUserIds.push(authorId);
    const sid = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    await withE2eDb((q) =>
      q.exec(
        "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, NOW(), '2027-01-01 08:00:00', NOW())",
        [sid, authorId],
      ),
    );

    const banPath = `/api/manage/users/${authorId}/restrictions`;
    const banData = { kind: "ban", reason: "严重违规", endsAt: null };
    const post = (data: Record<string, unknown>, key = randomUUID()) =>
      request.post(banPath, {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data,
      });

    const key = randomUUID();
    const ban = await post(banData, key);
    expect(ban.status()).toBe(200);
    expect(await ban.json()).toEqual({
      ok: true,
      data: { userId: authorId, kind: "ban", scopeId: 0, endsAt: null },
    });
    // 全站封禁同一事务吊销全部会话
    const sessions = await withE2eDb((q) =>
      q.query("SELECT id FROM sessions WHERE user_id = ?", [authorId]),
    );
    expect(sessions).toHaveLength(0);
    // 同键回放同响应；新键重复封禁 409
    const replay = await post(banData, key);
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual({
      ok: true,
      data: { userId: authorId, kind: "ban", scopeId: 0, endsAt: null },
    });
    await expectManageError(
      await post({ kind: "ban", reason: "重复", endsAt: null }),
      409,
      "state_conflict",
    );
    await withE2eDb((q) => q.exec("DELETE FROM user_restrictions WHERE user_id = ?", [authorId]));
  });

  test("会话吊销：行删除、同键回放命中缓存、新意图 404", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "会话吊销：行", { users: "write" });
    const authorId = await withE2eDb((q) => createAuthorUser(q, `${TAG}-session`));
    authorUserIds.push(authorId);
    const sid = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    await withE2eDb((q) =>
      q.exec(
        "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, NOW(), '2027-01-01 08:00:00', NOW())",
        [sid, authorId],
      ),
    );
    const sessionPath = `/api/manage/users/${authorId}/sessions/${sid}`;
    const revoke = (key: string) =>
      request.delete(sessionPath, {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data: {},
      });

    // 首次吊销：行删除；同键回放在行已删后仍命中缓存（删除型写的幂等语义——基建回放短路）
    const key = randomUUID();
    expect((await revoke(key)).status()).toBe(200);
    const replay = await revoke(key);
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual({
      ok: true,
      data: { sessionId: sid, userId: authorId, revoked: true },
    });
    // 新键再吊销（目标已不存在）→ 404；畸形 sessionId → 404
    await expectManageError(await revoke(randomUUID()), 404, "not_found");
    const malformed = await request.delete(`/api/manage/users/${authorId}/sessions/not-hex`, {
      headers: {
        ...bearer(writer),
        "Idempotency-Key": randomUUID(),
        "content-type": "application/json",
      },
      data: {},
    });
    await expectManageError(malformed, 404, "not_found");
    await withE2eDb((q) => q.exec("DELETE FROM sessions WHERE user_id = ?", [authorId]));
  });

  test("申诉处置：归属校验、approved 落账、回放与重复拒绝", async ({ page, request }) => {
    // identity:read 供 whoami 取处置人 ID（whoami 属身份域，users:write 令牌默认跨域 403）
    const writer = await issueWriterToken(page, "申诉处置：归", {
      users: "write",
      identity: "read",
    });
    const authorId = await withE2eDb((q) => createAuthorUser(q, `${TAG}-appeal`));
    authorUserIds.push(authorId);
    await withE2eDb((q) =>
      q.exec(
        "INSERT INTO user_restrictions (user_id, kind, scope_id, reason, starts_at, ends_at, created_by, created_at) VALUES (?, 'mute', 0, '夹具', NOW(), '2027-01-01 08:00:00', ?, NOW())",
        [authorId, USERS.admin],
      ),
    );
    const [restriction] = await withE2eDb((q) =>
      q.query<{ id: number }>("SELECT id FROM user_restrictions WHERE user_id = ?", [authorId]),
    );
    const appealId = (
      await withE2eDb((q) =>
        q.exec(
          "INSERT INTO user_appeals (user_id, target_type, target_id, reason, status, created_at) VALUES (?, 'restriction', ?, '请求解除', 'pending', NOW())",
          [authorId, restriction.id],
        ),
      )
    ).insertId;

    // 归属不匹配（uid 与申诉人不符）→ 404
    const otherId = await withE2eDb((q) => createAuthorUser(q, `${TAG}-appeal-b`));
    authorUserIds.push(otherId);
    const resolvePath = (uid: number) => `/api/manage/users/${uid}/appeals/${appealId}/resolve`;
    const post = (uid: number, data: Record<string, unknown>, key = randomUUID()) =>
      request.post(resolvePath(uid), {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data,
      });
    await expectManageError(
      await post(otherId, { status: "approved", result: "越权" }),
      404,
      "not_found",
    );

    // approved 落账 + 申诉人收到 resolved 强制通知
    const who = await request.get("/api/manage/whoami", { headers: bearer(writer) });
    const writerAdminId = ((await who.json()) as { data: { user: { id: number } } }).data.user.id;
    const key = randomUUID();
    const resolved = await post(authorId, { status: "approved", result: "核实后同意解除" }, key);
    expect(resolved.status()).toBe(200);
    expect(await resolved.json()).toEqual({ ok: true, data: { appealId, status: "approved" } });
    const [row] = await withE2eDb((q) =>
      q.query<{ status: string; handledBy: number }>(
        "SELECT status, handled_by AS handledBy FROM user_appeals WHERE id = ?",
        [appealId],
      ),
    );
    expect(row).toEqual({ status: "approved", handledBy: writerAdminId });
    const notices = await withE2eDb((q) =>
      q.query<{ type: string }>(
        "SELECT type FROM notifications WHERE user_id = ? AND type = 'account.appeal_resolved'",
        [authorId],
      ),
    );
    expect(notices).toHaveLength(1);
    // 同键回放同响应；新键再处置 409
    const replay = await post(authorId, { status: "approved", result: "核实后同意解除" }, key);
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, data: { appealId, status: "approved" } });
    await expectManageError(
      await post(authorId, { status: "rejected", result: "改判" }),
      409,
      "state_conflict",
    );
    await withE2eDb((q) => q.exec("DELETE FROM user_appeals WHERE id = ?", [appealId]));
    await withE2eDb((q) => q.exec("DELETE FROM user_restrictions WHERE user_id = ?", [authorId]));
  });

  test("公告：发布、条件审计、下线与回放", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "公告：发布、", {
      announcements: "write",
      identity: "read",
    });
    const post = (data: Record<string, unknown>, key = randomUUID()) =>
      request.post("/api/manage/announcements", {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data,
      });
    const body = {
      title: `${TAG} REST 公告`,
      bodyMd: "v1",
      level: "important",
      audience: "all",
      showBanner: false,
      startsAt: null,
      endsAt: null,
    };

    // 创建（startsAt null = 立即开始）：落账 + 同键回放同响应
    const key = randomUUID();
    const created = await post(body, key);
    expect(created.status()).toBe(200);
    const announcementId = ((await created.json()) as { data: { announcementId: number } }).data
      .announcementId;
    const replay = await post(body, key);
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, data: { announcementId } });

    // 详情可见；编辑值变化 → changed:true + 审计；同值编辑 → changed:false 不加审计
    const detail = await request.get(`/api/manage/announcements/${announcementId}`, {
      headers: bearer(writer),
    });
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({
      data: { id: announcementId, title: body.title, status: "active" },
    });
    const editCount = async () =>
      (
        await withE2eDb((q) =>
          q.query<{ n: number }>(
            "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'announcement.edit' AND target_id = ?",
            [announcementId],
          ),
        )
      )[0].n;
    const patch = (data: Record<string, unknown>, key2 = randomUUID()) =>
      request.patch(`/api/manage/announcements/${announcementId}`, {
        headers: { ...bearer(writer), "Idempotency-Key": key2, "content-type": "application/json" },
        data,
      });
    const changed = await patch({ ...body, bodyMd: "v2" });
    expect(changed.status()).toBe(200);
    expect(await changed.json()).toEqual({
      ok: true,
      data: { announcementId, changed: true },
    });
    expect(await editCount()).toBe(1);
    const same = await patch({ ...body, bodyMd: "v2" });
    expect(await same.json()).toEqual({ ok: true, data: { announcementId, changed: false } });
    expect(await editCount()).toBe(1);

    // 下线：status → ended；详情仍可见（管理视角）
    const end = await request.post(`/api/manage/announcements/${announcementId}/end`, {
      headers: {
        ...bearer(writer),
        "Idempotency-Key": randomUUID(),
        "content-type": "application/json",
      },
      data: {},
    });
    expect(end.status()).toBe(200);
    const after = await request.get(`/api/manage/announcements/${announcementId}`, {
      headers: bearer(writer),
    });
    expect(await after.json()).toMatchObject({ data: { id: announcementId, status: "ended" } });
    await withE2eDb((q) => q.exec("DELETE FROM announcements WHERE id = ?", [announcementId]));
  });

  test("活动：乐观锁 409、同值启停零变更与回放", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "活动：乐观锁", {
      campaigns: "write",
      identity: "read",
    });
    const fields = {
      name: `${TAG} REST 活动`,
      effect: "theme.pack",
      target: "default",
      startsAt: "2027-01-01 00:00:00",
      endsAt: "2027-02-01 00:00:00",
      priority: 0,
    };
    const created = await request.post("/api/manage/campaigns", {
      headers: {
        ...bearer(writer),
        "Idempotency-Key": randomUUID(),
        "content-type": "application/json",
      },
      data: fields,
    });
    expect(created.status()).toBe(200);
    const campaignId = ((await created.json()) as { data: { id: number } }).data.id;

    // 详情与列表同源
    const detail = await request.get(`/api/manage/campaigns/${campaignId}`, {
      headers: bearer(writer),
    });
    expect(await detail.json()).toMatchObject({
      data: { id: campaignId, name: fields.name, revision: 1, status: "upcoming" },
    });

    const patch = (data: Record<string, unknown>, key = randomUUID()) =>
      request.patch(`/api/manage/campaigns/${campaignId}`, {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data,
      });
    // 旧 revision → 409；新 revision → 成功 revision+1
    await expectManageError(
      await patch({ ...fields, expectedRevision: 99 }),
      409,
      "state_conflict",
    );
    const editKey = randomUUID();
    const edited = { ok: true, data: { id: campaignId, revision: 2 } };
    expect(await (await patch({ ...fields, expectedRevision: 1 }, editKey)).json()).toEqual(edited);
    expect(await (await patch({ ...fields, expectedRevision: 1 }, editKey)).json()).toEqual(edited);
    await expectManageError(
      await patch({ ...fields, expectedRevision: 2 }, editKey),
      409,
      "idempotency_conflict",
    );

    // 同值启停 changed:false revision 不变；异值启停 revision+1
    const enable = (enabled: boolean, key = randomUUID()) =>
      request.post(`/api/manage/campaigns/${campaignId}/enabled`, {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data: { enabled },
      });
    expect(await enable(true).then((r) => r.json())).toEqual({
      ok: true,
      data: { id: campaignId, revision: 2, enabled: true, changed: false },
    });
    expect(await enable(false).then((r) => r.json())).toEqual({
      ok: true,
      data: { id: campaignId, revision: 3, enabled: false, changed: true },
    });
    // 启停同键回放返回首次结果
    const toggleKey = randomUUID();
    expect(await enable(true, toggleKey).then((r) => r.status())).toBe(200);
    const toggleReplay = await enable(true, toggleKey);
    expect(toggleReplay.status()).toBe(200);
    expect(await toggleReplay.json()).toEqual({
      ok: true,
      data: { id: campaignId, revision: 4, enabled: true, changed: true },
    });
    await withE2eDb((q) => q.exec("DELETE FROM campaigns WHERE id = ?", [campaignId]));
  });

  test("邀请码：生成回放同码、吊销与批次吊销", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "邀请码：生成", {
      invites: "write",
      identity: "read",
    });
    const batch = `${TAG}-inv-first`;
    const secondBatch = `${TAG}-inv-second`;
    const expiredBatch = `${TAG}-inv-expired`;
    const consumerTag = `${TAG}-inv-consumer`;
    const consumerId = await withE2eDb((q) => createAuthorUser(q, consumerTag));
    authorUserIds.push(consumerId);
    const write = (method: string, path: string, data: object, key = randomUUID()) =>
      request.fetch(`/api/manage/invites${path}`, {
        method,
        headers: { ...bearer(writer), "Idempotency-Key": key },
        data,
      });
    const revoke = (code: string, key = randomUUID()) => write("DELETE", `/${code}`, {}, key);
    const revokeBatch = (name: string) =>
      write("POST", `/batches/${encodeURIComponent(name)}/revoke`, {});
    const list = async (name: string, status: string) => {
      const response = await request.get("/api/manage/invites", {
        headers: bearer(writer),
        params: { batch: name, status, size: 10 },
      });
      expect(response.status()).toBe(200);
      return response.json();
    };

    try {
      // 第一批各保留一条可用、已用码；另两批分别作可用码干扰项和过期状态夹具。
      const genKey = randomUUID();
      const fields = { count: 3, days: 30, batch };
      const first = await write("POST", "", fields, genKey);
      expect(first.status()).toBe(200);
      const { codes } = ((await first.json()) as { data: { codes: string[] } }).data;
      expect(codes).toHaveLength(3);
      const [available, used, expired] = codes;
      const replay = await write("POST", "", fields, genKey);
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, data: { codes, count: 3, batch } });
      await expectManageError(
        await write("POST", "", { ...fields, count: 21 }),
        400,
        "bad_request",
      );
      expect((await write("POST", "", { count: 2, days: 0, batch: secondBatch })).status()).toBe(
        200,
      );
      await withE2eDb(async (q) => {
        await q.exec("UPDATE invite_codes SET used_by = ?, used_at = NOW() WHERE code = ?", [
          consumerId,
          used,
        ]);
        await q.exec(
          "UPDATE invite_codes SET batch = ?, expires_at = '2000-01-01 00:00:00' WHERE code = ?",
          [expiredBatch, expired],
        );
      });

      expect(await list(batch, "available")).toMatchObject({
        ok: true,
        data: { total: 1, items: [{ code: available, batch, status: "available", usedBy: null }] },
      });
      expect(await list(batch, "used")).toMatchObject({
        ok: true,
        data: {
          total: 1,
          items: [
            {
              code: used,
              batch,
              status: "used",
              usedBy: consumerId,
              usedByName: `e2e-manage-author-${consumerTag}`,
              usedAt: expect.any(String),
            },
          ],
        },
      });
      expect(await list(expiredBatch, "expired")).toMatchObject({
        ok: true,
        data: {
          total: 1,
          items: [{ code: expired, batch: expiredBatch, status: "expired", usedBy: null }],
        },
      });

      // 单码吊销：同键回放同值，新键找不到；已用码不可吊销。
      const revokeKey = randomUUID();
      expect((await revoke(available, revokeKey)).status()).toBe(200);
      const revokeReplay = await revoke(available, revokeKey);
      expect(revokeReplay.status()).toBe(200);
      expect(await revokeReplay.json()).toEqual({
        ok: true,
        data: { code: available, revoked: true },
      });
      await expectManageError(await revoke(available), 404, "not_found");
      await expectManageError(await revoke(used), 409, "state_conflict");
      await expectManageError(await revokeBatch(batch), 404, "not_found");
      const batchRevoked = await revokeBatch(secondBatch);
      expect(batchRevoked.status()).toBe(200);
      expect(await batchRevoked.json()).toEqual({
        ok: true,
        data: { batch: secondBatch, revoked: 2 },
      });
      expect(await list(secondBatch, "all")).toMatchObject({ data: { total: 0, items: [] } });
    } finally {
      await withE2eDb((q) =>
        q.exec("DELETE FROM invite_codes WHERE batch IN (?, ?, ?)", [
          batch,
          secondBatch,
          expiredBatch,
        ]),
      );
    }
  });

  test("版块：创建/编辑/前缀/删除守卫与回放", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "版块：创建/", {
      forums: "write",
      identity: "read",
    });
    const write = (method: string, path: string, data: object, key = randomUUID()) =>
      request.fetch(`/api/manage/forums${path}`, {
        method,
        headers: { ...bearer(writer), "Idempotency-Key": key },
        data,
      });
    const fields = {
      parentId: 906,
      kind: "forum",
      name: `${TAG} REST 版块`,
      description: null,
      sortOrder: 0,
      isListed: true,
    };
    const editedName = `${fields.name}（改）`;
    try {
      await expectManageError(
        await write("POST", "", { ...fields, parentId: 999999999 }),
        404,
        "not_found",
      );
      const createKey = randomUUID();
      const created = await write("POST", "", fields, createKey);
      expect(created.status()).toBe(200);
      const { id: fid } = ((await created.json()) as { data: { id: number } }).data;
      const replay = await write("POST", "", fields, createKey);
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, data: { id: fid } });

      const forumPath = `/${fid}`;
      const read = async (path: string) => {
        const response = await request.get(`/api/manage/forums${path}`, {
          headers: bearer(writer),
        });
        expect(response.status()).toBe(200);
        return response.json();
      };
      const edited = {
        parentId: fields.parentId,
        name: editedName,
        description: null,
        sortOrder: 3,
        isListed: false,
        readPolicy: "inherit",
        writePolicy: "inherit",
        reviewPolicy: "inherit",
        isArchived: true,
      };
      expect((await write("PATCH", forumPath, edited)).status()).toBe(200);
      const forum = { id: fid, path: `/900/906/${fid}/`, depth: 3, kind: "forum", ...edited };
      expect(await read("")).toMatchObject({
        ok: true,
        data: { items: expect.arrayContaining([expect.objectContaining(forum)]) },
      });
      expect(await read(forumPath)).toMatchObject({ ok: true, data: { ...forum, prefixes: [] } });

      const prefixFields = { name: "完结", sortOrder: 1 };
      const prefix = await write("POST", `${forumPath}/prefixes`, prefixFields);
      expect(prefix.status()).toBe(200);
      const prefixBody = (await prefix.json()) as { data: { prefixId: number } };
      const { prefixId } = prefixBody.data;
      expect(prefixBody).toEqual({ ok: true, data: { forumId: fid, prefixId } });
      expect(await read(forumPath)).toMatchObject({
        data: { prefixes: [{ id: prefixId, forumId: fid, ...prefixFields }] },
      });
      const removed = await write("DELETE", `${forumPath}/prefixes/${prefixId}`, {});
      expect(removed.status()).toBe(200);
      expect(await removed.json()).toEqual({ ok: true, data: { id: fid } });
      expect(await read(forumPath)).toMatchObject({ data: { prefixes: [] } });

      // 空版块可删除，同键回放仍成功，新键找不到。
      const delKey = randomUUID();
      expect((await write("DELETE", forumPath, {}, delKey)).status()).toBe(200);
      expect((await write("DELETE", forumPath, {}, delKey)).status()).toBe(200);
      await expectManageError(await write("DELETE", forumPath, {}), 404, "not_found");
    } finally {
      await withE2eDb(async (q) => {
        const names = [fields.name, editedName];
        await q.exec(
          "DELETE fp FROM forum_prefixes fp JOIN forums f ON f.id = fp.forum_id WHERE f.name IN (?, ?)",
          names,
        );
        await q.exec("DELETE FROM forums WHERE name IN (?, ?)", names);
      });
    }
  });

  test("投票：threadId 口径、截止/重开/删除与回放", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "投票：thread", {
      polls: "write",
      identity: "read",
    });
    const title = `${TAG}-poll`;
    const { target, authorId } = await seedContentThread(title, "visible");
    const forumId = contentForumId;
    const pollInList = async (status: string) => {
      const response = await request.get("/api/manage/polls", {
        headers: bearer(writer),
        params: { forumId, status, size: 100 },
      });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        data: { items: { threadId: number }[] };
      };
      expect(body.ok).toBe(true);
      return body.data.items.find((item) => item.threadId === target.threadId);
    };
    const write = (method: string, suffix: string, key = randomUUID()) =>
      request.fetch(`/api/manage/polls/${target.threadId}${suffix}`, {
        method,
        headers: { ...bearer(writer), "Idempotency-Key": key },
        data: {},
      });

    try {
      const pollId = await withE2eDb(async (q) => {
        await q.exec("UPDATE threads SET kind = 'poll' WHERE id = ?", [target.threadId]);
        const { insertId } = await q.exec(
          "INSERT INTO polls (thread_id, created_by, ends_at, created_at) VALUES (?, ?, NOW() + INTERVAL 30 DAY, NOW())",
          [target.threadId, authorId],
        );
        await q.exec(
          "INSERT INTO poll_options (poll_id, content, sort_order) VALUES (?, '选项甲', 1), (?, '选项乙', 2)",
          [insertId, insertId],
        );
        return insertId;
      });
      const row = {
        pollId,
        threadId: target.threadId,
        title,
        forumId,
        optionCount: 2,
        totalVotes: 0,
        voterCount: 0,
      };
      expect(await pollInList("open")).toMatchObject({
        ...row,
        closed: false,
        endsAt: expect.any(String),
      });

      const closeKey = randomUUID();
      expect((await write("POST", "/close", closeKey)).status()).toBe(200);
      expect((await write("POST", "/close", closeKey)).status()).toBe(200);
      await expectManageError(await write("POST", "/close"), 409, "state_conflict");
      expect(await pollInList("closed")).toMatchObject({
        ...row,
        closed: true,
        endsAt: expect.any(String),
      });
      expect(await pollInList("open")).toBeUndefined();

      // 重开清除截止时间，列表恢复为开放态；删除时主题恢复普通帖。
      expect((await write("POST", "/reopen")).status()).toBe(200);
      expect(await pollInList("open")).toMatchObject({ ...row, closed: false, endsAt: null });
      expect((await write("DELETE", "")).status()).toBe(200);
      expect(await pollInList("all")).toBeUndefined();
      const [kind] = await withE2eDb((q) =>
        q.query<{ kind: string }>("SELECT kind FROM threads WHERE id = ?", [target.threadId]),
      );
      expect(kind.kind).toBe("normal");
    } finally {
      await withE2eDb(async (q) => {
        await q.exec(
          "DELETE po FROM poll_options po JOIN polls p ON p.id = po.poll_id WHERE p.thread_id = ?",
          [target.threadId],
        );
        await q.exec("DELETE FROM polls WHERE thread_id = ?", [target.threadId]);
      });
    }
  });

  test("私信：软删覆写与回放", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "私信：软删", { pm: "write", identity: "read" });
    const pairKey = `${TAG}-pm-${randomUUID().slice(0, 8)}`;
    const convId = (
      await withE2eDb((q) =>
        q.exec(
          "INSERT INTO conversations (kind, pair_key, last_message_at, created_at) VALUES ('direct', ?, NOW(), NOW())",
          [pairKey],
        ),
      )
    ).insertId;
    const msgId = (
      await withE2eDb((q) =>
        q.exec(
          "INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, 90002, '待删消息', NOW())",
          [convId],
        ),
      )
    ).insertId;

    const delKey = randomUUID();
    const del = (key = delKey) =>
      request.delete(`/api/manage/pm/messages/${msgId}`, {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data: { reason: "违规内容" },
      });
    expect((await del()).status()).toBe(200);
    // 同键回放同响应；正文已覆写（软删），行保留
    expect((await del()).status()).toBe(200);
    const [row] = await withE2eDb((q) =>
      q.query<{ body: string }>("SELECT body FROM messages WHERE id = ?", [msgId]),
    );
    expect(row.body).toContain("已由管理员删除");
    await withE2eDb((q) => q.exec("DELETE FROM messages WHERE conversation_id = ?", [convId]));
    await withE2eDb((q) => q.exec("DELETE FROM conversations WHERE id = ?", [convId]));
  });

  test("徽章：授予通知、重复 409、撤销与字典", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "徽章：授予", {
      badges: "write",
      identity: "read",
    });
    const targetId = await withE2eDb((q) => createAuthorUser(q, `${TAG}-badge`));
    authorUserIds.push(targetId);
    const badgeKey = `rest-badge-${TAG}`;
    const excludedKeys = [`${badgeKey}-inactive`, `${badgeKey}-team`];
    const name = `REST 徽章 ${TAG}`;
    const description = "管理接口字典验收";
    try {
      const badgeId = await withE2eDb(async (q) => {
        const { insertId } = await q.exec(
          "INSERT INTO badges (`key`, name, description, kind, is_active) VALUES (?, ?, ?, 'honor', 1)",
          [badgeKey, name, description],
        );
        await q.exec(
          "INSERT INTO badges (`key`, name, kind, is_active) VALUES (?, '已停用', 'honor', 0), (?, '团队', 'team', 1)",
          excludedKeys,
        );
        return insertId;
      });
      // 字典只收录启用的荣誉徽章，分别验证停用与团队两种排除条件。
      const dict = await request.get("/api/manage/badges", { headers: bearer(writer) });
      expect(dict.status()).toBe(200);
      const body = (await dict.json()) as { ok: boolean; data: { items: { key: string }[] } };
      expect(body.ok).toBe(true);
      const candidates = new Set([badgeKey, ...excludedKeys]);
      expect(body.data.items.filter((item) => candidates.has(item.key))).toEqual([
        { id: badgeId, key: badgeKey, name, description, kind: "honor", isActive: true },
      ]);

      const write = (method: string) =>
        request.fetch(`/api/manage/users/${targetId}/badges/${badgeId}`, {
          method,
          headers: { ...bearer(writer), "Idempotency-Key": randomUUID() },
          data: {},
        });
      expect((await write("POST")).status()).toBe(200);
      await expectManageError(await write("POST"), 409, "state_conflict");
      const notices = await withE2eDb((q) =>
        q.query<{ type: string }>(
          "SELECT type FROM notifications WHERE user_id = ? AND type = 'badge.awarded'",
          [targetId],
        ),
      );
      expect(notices).toHaveLength(1);
      expect((await write("DELETE")).status()).toBe(200);
      await expectManageError(await write("DELETE"), 404, "not_found");
    } finally {
      await withE2eDb(async (q) => {
        await q.exec("DELETE FROM user_badges WHERE user_id = ?", [targetId]);
        await q.exec("DELETE FROM badges WHERE `key` IN (?, ?, ?)", [badgeKey, ...excludedKeys]);
      });
    }
  });

  test("积分：调账落台账、回放同结果、规则聚合", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "积分：调账", {
      points: "write",
      identity: "read",
    });
    const targetId = await withE2eDb((q) => createAuthorUser(q, `${TAG}-points`));
    authorUserIds.push(targetId);
    const adjust = (token: string, delta: number, note: string, key = randomUUID()) =>
      request.post("/api/manage/points/adjustments", {
        headers: { ...bearer(token), "Idempotency-Key": key },
        data: { userId: targetId, delta, note },
      });
    const assertAdjustment = async (
      response: Awaited<ReturnType<typeof adjust>>,
      delta: number,
      balanceAfter: number,
    ) => {
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        data: { userId: targetId, delta, balanceAfter },
      });
    };
    const ledgerPage = async (page: number) => {
      const response = await request.get("/api/manage/points/ledger", {
        headers: bearer(writer),
        params: { userId: targetId, size: 10, page },
      });
      expect(response.status()).toBe(200);
      return response.json();
    };

    try {
      const who = await request.get("/api/manage/whoami", { headers: bearer(writer) });
      expect(who.status()).toBe(200);
      const { id: refId } = ((await who.json()) as { data: { user: { id: number } } }).data.user;
      const entry = (delta: number, balanceAfter: number, note: string) => ({
        id: expect.any(Number),
        delta,
        balanceAfter,
        channel: "adjust.admin",
        note,
        refType: "admin",
        refId,
      });
      await expectManageError(await adjust(writer, 0, "零额调整"), 400, "bad_request");
      const key = randomUUID();
      const firstNote = "REST 首笔调账";
      await assertAdjustment(await adjust(writer, 50, firstNote, key), 50, 50);
      await assertAdjustment(await adjust(writer, 50, firstNote, key), 50, 50);

      // 最小合法档位是 10；使用同一管理员的第二枚令牌写入九笔，避免撞每令牌十次写配额。
      const seedName = `${NAME_PREFIX}积分台账夹具`;
      tokenNames.push(seedName);
      const seeder = await issueManageToken(page, seedName, { points: "write" });
      const firstPage = [];
      for (let i = 1; i <= 9; i++) {
        const note = `REST 分页夹具 ${i}`;
        await assertAdjustment(await adjust(seeder, 1, note), 1, 50 + i);
        firstPage.unshift(entry(1, 50 + i, note));
      }
      const lastNote = "REST 冲减调账";
      await assertAdjustment(await adjust(writer, -11, lastNote), -11, 48);
      firstPage.unshift(entry(-11, 48, lastNote));
      const account = {
        total: 11,
        totalPages: 2,
        balance: 48,
        lifetimeEarned: 59,
        lifetimeSpent: 11,
      };
      expect(await ledgerPage(1)).toMatchObject({
        ok: true,
        data: { ...account, page: 1, items: firstPage },
      });
      expect(await ledgerPage(2)).toMatchObject({
        ok: true,
        data: { ...account, page: 2, items: [entry(50, 50, firstNote)] },
      });

      // 写入非默认规则，防止聚合端点即使只返回默认值也能通过。
      const threadReward = { post: 13, reply: 4, postDailyCap: 39, replyDailyCap: 20 };
      const punchReward = { min: 7, max: 12 };
      const gateFeeRate = 0.25;
      const settings = [
        ["points.reward", threadReward],
        ["punch.reward", punchReward],
        ["points.gate_fee_rate", { rate: gateFeeRate }],
      ] as const;
      const previous = await withE2eDb((q) =>
        q.query<{ key: string; valueJson: string | null; updatedAt: string }>(
          "SELECT `key`, CAST(value AS CHAR) AS valueJson, updated_at AS updatedAt FROM site_settings WHERE `key` IN (?, ?, ?)",
          settings.map(([name]) => name),
        ),
      );
      try {
        await withE2eDb(async (q) => {
          for (const [name, value] of settings) {
            const json = JSON.stringify(value);
            await q.exec(
              "INSERT INTO site_settings (`key`, value, updated_at) VALUES (?, CAST(? AS JSON), NOW()) ON DUPLICATE KEY UPDATE value = CAST(? AS JSON), updated_at = NOW()",
              [name, json, json],
            );
          }
        });
        const rules = await request.get("/api/manage/points/rules", { headers: bearer(writer) });
        expect(rules.status()).toBe(200);
        expect(await rules.json()).toEqual({
          ok: true,
          data: { threadReward, punchReward, gateFeeRate },
        });
      } finally {
        await withE2eDb(async (q) => {
          for (const [name] of settings) {
            const saved = previous.find(({ key }) => key === name);
            if (saved) {
              await q.exec(
                "UPDATE site_settings SET value = CAST(? AS JSON), updated_at = ? WHERE `key` = ?",
                [saved.valueJson, saved.updatedAt, name],
              );
            } else {
              await q.exec("DELETE FROM site_settings WHERE `key` = ?", [name]);
            }
          }
        });
      }
    } finally {
      await withE2eDb(async (q) => {
        await q.exec("DELETE FROM point_ledger WHERE user_id = ?", [targetId]);
        await q.exec("DELETE FROM point_accounts WHERE user_id = ?", [targetId]);
      });
    }
  });

  test("角色：创建回放、授权护栏、防自锁及用户绑定与解绑", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "角色", { roles: "write" });
    const roleKey = `rest-${TAG}`;
    const rolePath = `/api/manage/roles/${roleKey}`;
    const write = (method: string, path: string, data: object, key = randomUUID()) =>
      request.fetch(path, {
        method,
        headers: { ...bearer(writer), "Idempotency-Key": key },
        data,
      });

    const listedRole = async () => {
      const response = await request.get("/api/manage/roles", { headers: bearer(writer) });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { ok: boolean; data: { items: { key: string }[] } };
      expect(body.ok).toBe(true);
      return body.data.items.find((item) => item.key === roleKey);
    };

    // 全用例共十次写请求，正好覆盖单令牌写配额。
    try {
      const createKey = randomUUID();
      const fields = { key: roleKey, name: "REST 角色", description: "" };
      const created = await write("POST", "/api/manage/roles", fields, createKey);
      expect(created.status()).toBe(200);
      const receipt = { ok: true, data: { key: roleKey, name: fields.name } };
      expect(await created.json()).toEqual(receipt);
      const replay = await write("POST", "/api/manage/roles", fields, createKey);
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toEqual(receipt);
      await expectManageError(
        await write("POST", "/api/manage/roles", fields),
        409,
        "state_conflict",
      );

      await expectManageError(
        await write("PUT", "/api/manage/roles/member/grants/forum.moderate", { scopeId: 0 }),
        409,
        "state_conflict",
      );
      const grant = await write("PUT", `${rolePath}/grants/forum.moderate`, { scopeId: 0 });
      expect(grant.status()).toBe(200);
      expect(await grant.json()).toMatchObject({ data: { changed: true } });
      await expectManageError(
        await write("DELETE", "/api/manage/roles/admin/grants/site.admin", { scopeId: 0 }),
        409,
        "state_conflict",
      );

      const detail = await request.get(rolePath, { headers: bearer(writer) });
      expect(detail.status()).toBe(200);
      expect(await detail.json()).toMatchObject({
        data: { key: roleKey, grants: [{ permissionKey: "forum.moderate", scopeId: 0 }] },
      });

      // 用户绑定归令牌角色域，持有人另须具备用户管理权限。
      const targetId = await withE2eDb((q) => createAuthorUser(q, `${TAG}-role-user`));
      authorUserIds.push(targetId);
      const assignPath = `/api/manage/users/${targetId}/roles/${roleKey}`;
      await expectManageError(
        await write("PUT", assignPath, { scopeId: 0, expiresAt: null, reason: "" }),
        400,
        "bad_request",
      );
      const assign = await write("PUT", assignPath, {
        scopeId: 0,
        expiresAt: null,
        reason: "接任审校",
      });
      expect(assign.status()).toBe(200);
      expect(await assign.json()).toMatchObject({
        data: { userId: targetId, roleKey, scopeId: 0 },
      });
      const listFields = { ...fields, kind: "custom", isPublic: false, grantCount: 1 };
      expect(await listedRole()).toEqual({ ...listFields, holderCount: 1 });
      const revoke = await write("DELETE", assignPath, { scopeId: 0, reason: "卸任" });
      expect(revoke.status()).toBe(200);
      expect(await revoke.json()).toMatchObject({ data: { changed: true } });
      expect(await listedRole()).toEqual({ ...listFields, holderCount: 0 });
      expect((await write("DELETE", rolePath, {})).status()).toBe(200);
      expect(await listedRole()).toBeUndefined();
    } finally {
      await withE2eDb(async (q) => {
        await q.exec("DELETE FROM user_roles WHERE role_key = ?", [roleKey]);
        await q.exec("DELETE FROM role_grants WHERE role_key = ?", [roleKey]);
        await q.exec("DELETE FROM roles WHERE `key` = ?", [roleKey]);
      });
    }
  });

  test("设置：白名单分组读写与回放", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "设置", { settings: "write" });
    const index = await request.get("/api/manage/settings", { headers: bearer(writer) });
    expect(index.status()).toBe(200);
    const {
      data: { groups },
    } = (await index.json()) as { data: { groups: string[] } };
    expect(groups).toContain("register");
    expect(groups).not.toContain("smtp");

    type RegisterPolicy = { open: boolean; invite: boolean; verifyEmail: boolean };
    const [previous] = await withE2eDb((q) =>
      q.query<{ value: RegisterPolicy; updatedAt: string }>(
        "SELECT value, updated_at AS updatedAt FROM site_settings WHERE `key` = 'register.policy'",
      ),
    );
    const readRegister = () =>
      request.get("/api/manage/settings?group=register", { headers: bearer(writer) });
    const register = await readRegister();
    expect(register.status()).toBe(200);
    const group = { group: "register", key: "register.policy" };
    expect(await register.json()).toMatchObject({
      data: { ...group, value: previous?.value ?? null },
    });
    await expectManageError(
      await request.get("/api/manage/settings?group=smtp", { headers: bearer(writer) }),
      404,
      "not_found",
    );

    const patchKey = randomUUID();
    const current = previous?.value ?? { open: false, invite: true, verifyEmail: false };
    const updated = { ...current, verifyEmail: !current.verifyEmail };
    const patch = () =>
      request.patch("/api/manage/settings/register", {
        headers: { ...bearer(writer), "Idempotency-Key": patchKey },
        data: updated,
      });
    try {
      const first = await patch();
      expect(first.status()).toBe(200);
      const receipt = { ok: true, data: group };
      expect(await first.json()).toMatchObject(receipt);
      const replay = await patch();
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toEqual(await first.json());
      expect(await (await readRegister()).json()).toMatchObject({
        data: { ...group, value: updated },
      });
      await expectManageError(
        await request.patch("/api/manage/settings/smtp", {
          headers: { ...bearer(writer), "Idempotency-Key": randomUUID() },
          data: { url: "test.invalid" },
        }),
        404,
        "not_found",
      );
    } finally {
      await withE2eDb((q) =>
        previous
          ? q.exec(
              "UPDATE site_settings SET value = CAST(? AS JSON), updated_at = ? WHERE `key` = 'register.policy'",
              [JSON.stringify(previous.value), previous.updatedAt],
            )
          : q.exec("DELETE FROM site_settings WHERE `key` = 'register.policy'"),
      );
    }
  });

  test("运维：任务列表、配置回放、断连触发返回 503", async ({ page, request }) => {
    expectOpsPipelineDisconnected(test.info().config);
    const writer = await issueWriterToken(page, "运维", { ops: "write" });
    const taskKey = `rest.${TAG}`;
    const taskPath = `/api/manage/ops/tasks/${taskKey}`;
    const trigger = (path = taskPath) =>
      request.post(`${path}/trigger`, {
        headers: bearer(writer),
        data: {},
      });
    const patch = (suffix: "params" | "enabled", data: object, key = randomUUID()) =>
      request.patch(`${taskPath}/${suffix}`, {
        headers: { ...bearer(writer), "Idempotency-Key": key },
        data,
      });
    const listTasks = () => request.get("/api/manage/ops/tasks", { headers: bearer(writer) });

    try {
      // 专用任务仅添加手动触发器，验收不改动默认运维任务。
      const { insertId: id } = await withE2eDb((q) =>
        q.exec(
          `INSERT INTO ops_tasks (task_key, name, executor, params, enabled, revision, created_at, updated_at)
         VALUES (?, '运维验收任务', 'backup.db', JSON_OBJECT('keep', 14), 1, 1, NOW(), NOW())`,
          [taskKey],
        ),
      );
      await expectManageError(await trigger(`${taskPath}-missing`), 404, "not_found");
      await expectManageError(await trigger(), 400, "bad_request");
      await withE2eDb((q) =>
        q.exec(
          `INSERT INTO ops_triggers (task_key, kind, enabled, created_at, updated_at)
         VALUES (?, 'manual', 1, NOW(), NOW())`,
          [taskKey],
        ),
      );
      const tasks = await listTasks();
      expect(tasks.status()).toBe(200);
      expect(await tasks.json()).toMatchObject({
        data: {
          items: expect.arrayContaining([
            expect.objectContaining({
              id,
              taskKey,
              enabled: true,
              revision: 1,
              triggers: [expect.objectContaining({ kind: "manual", enabled: true })],
            }),
          ]),
        },
      });
      await expectManageError(await trigger(), 503, "ops_unavailable");

      await expectManageError(
        await patch("params", { expectedRevision: 2, params: { keep: 15 } }),
        409,
        "state_conflict",
      );
      const paramsKey = randomUUID();
      const params = { expectedRevision: 1, params: { keep: 15 } };
      const saved = await patch("params", params, paramsKey);
      expect(saved.status()).toBe(200);
      expect(await saved.json()).toMatchObject({ data: { id, revision: 2 } });
      const savedReplay = await patch("params", params, paramsKey);
      expect(savedReplay.status()).toBe(200);
      expect(await savedReplay.json()).toEqual(await saved.json());

      const toggleKey = randomUUID();
      const disabled = await patch("enabled", { enabled: false }, toggleKey);
      expect(disabled.status()).toBe(200);
      expect(await disabled.json()).toMatchObject({
        data: { id, enabled: false, revision: 3, changed: true },
      });
      const disabledReplay = await patch("enabled", { enabled: false }, toggleKey);
      expect(disabledReplay.status()).toBe(200);
      expect(await disabledReplay.json()).toEqual(await disabled.json());
      await expectManageError(await trigger(), 409, "state_conflict");

      const finalTasks = await listTasks();
      expect(finalTasks.status()).toBe(200);
      expect(await finalTasks.json()).toMatchObject({
        data: {
          items: expect.arrayContaining([
            expect.objectContaining({
              id,
              taskKey,
              enabled: false,
              params: { keep: 15 },
              revision: 3,
            }),
          ]),
        },
      });
    } finally {
      await withE2eDb(async (q) => {
        await q.exec("DELETE FROM ops_triggers WHERE task_key = ?", [taskKey]);
        await q.exec("DELETE FROM ops_tasks WHERE task_key = ?", [taskKey]);
      });
    }
  });

  test("运维台账：缺表正常降级，合成记录按真实字段返回", async ({ page, request }) => {
    expectOpsPipelineDisconnected(test.info().config);
    const reader = await issueWriterToken(page, "运维台账", { ops: "read" });
    const read = async () => {
      const response = await request.get("/api/manage/ops/runs?size=10", {
        headers: bearer(reader),
      });
      expect(response.status()).toBe(200);
      return response.json();
    };
    expect(await read()).toEqual({
      ok: true,
      data: { rows: [], total: 0, totalPages: 1, anyRunning: false, ledgerMissing: true },
    });

    // 台账表由管线自治；仅在隔离库创建同构的最小表，不接通管线或触发任务。
    await withE2eDb((q) =>
      q.exec(`CREATE TABLE ops_runs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      kind ENUM('db','storage','restore','drill','holiday') NOT NULL,
      task_key VARCHAR(64) NULL,
      trigger_source ENUM('cron','manual','once') NOT NULL,
      status ENUM('running','success','failed') NOT NULL,
      path VARCHAR(255) NULL, size_bytes BIGINT UNSIGNED NULL, detail TEXT NULL, error TEXT NULL,
      started_at DATETIME NOT NULL, finished_at DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`),
    );
    try {
      const taskKey = `rest.${TAG}.ledger`;
      const path = `${taskKey}.sql.gz`;
      const sizeBytes = 4700000;
      const detail = "合成台账验收记录";
      const startedAt = "2026-11-19 12:30:00";
      const finishedAt = "2026-11-19 12:30:05";
      const { insertId: id } = await withE2eDb((q) =>
        q.exec(
          `INSERT INTO ops_runs
             (kind, task_key, trigger_source, status, path, size_bytes, detail, started_at, finished_at)
           VALUES ('db', ?, 'manual', 'success', ?, ?, ?, ?, ?)`,
          [taskKey, path, sizeBytes, detail, startedAt, finishedAt],
        ),
      );
      expect(await read()).toEqual({
        ok: true,
        data: {
          rows: [
            {
              id,
              kind: "db",
              taskKey,
              trigger: "manual",
              status: "success",
              path,
              sizeBytes,
              detail,
              error: null,
              startedAt,
              finishedAt,
            },
          ],
          total: 1,
          totalPages: 1,
          anyRunning: false,
          ledgerMissing: false,
        },
      });
    } finally {
      // 只清理由本用例 CREATE 成功的表；若表已存在，上面的建表会拒绝，不会误删。
      await withE2eDb((q) => q.exec("DROP TABLE ops_runs"));
    }
  });

  test("主题：修订号乐观锁与启停回放", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "主题", { themes: "write" });
    const packId = `rest-${TAG}`;
    const packPath = `/api/manage/themes/${packId}`;
    const patch = (expectedRevision: number) =>
      request.patch(packPath, {
        headers: { ...bearer(writer), "Idempotency-Key": randomUUID() },
        data: { expectedRevision, name: `主题包 ${TAG}` },
      });
    const enable = (enabled: boolean, key = randomUUID()) =>
      request.post(`${packPath}/enabled`, {
        headers: { ...bearer(writer), "Idempotency-Key": key },
        data: { enabled },
      });
    try {
      // 复制稳定夹具的定义，独立测试启停，不改变共享主题包的状态。
      const seeded = await withE2eDb((q) =>
        q.exec(
          `INSERT INTO theme_packages (id, name, schema_version, definition, assets, enabled, created_at, updated_at)
         SELECT ?, '主题验收夹具', schema_version, definition, JSON_ARRAY(), 0, NOW(), NOW()
         FROM theme_packages WHERE id = ?`,
          [packId, FIX.customThemePack.id],
        ),
      );
      expect(seeded.affectedRows).toBe(1);
      const list = await request.get("/api/manage/themes", { headers: bearer(writer) });
      expect(list.status()).toBe(200);
      expect(await list.json()).toMatchObject({
        data: {
          items: expect.arrayContaining([
            expect.objectContaining({ id: packId, revision: 1, enabled: false }),
          ]),
        },
      });
      await expectManageError(await patch(2), 409, "state_conflict");
      const fresh = await patch(1);
      expect(fresh.status()).toBe(200);
      expect(await fresh.json()).toMatchObject({ data: { id: packId, revision: 2 } });

      const same = await enable(false);
      expect(same.status()).toBe(200);
      expect(await same.json()).toMatchObject({ data: { changed: false } });
      const toggleKey = randomUUID();
      const flip = await enable(true, toggleKey);
      expect(flip.status()).toBe(200);
      expect(await flip.json()).toMatchObject({ data: { changed: true } });
      const replay = await enable(true, toggleKey);
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toEqual(await flip.json());
      const detail = await request.get(packPath, { headers: bearer(writer) });
      expect(detail.status()).toBe(200);
      expect(await detail.json()).toMatchObject({
        data: {
          id: packId,
          name: `主题包 ${TAG}`,
          revision: 3,
          enabled: true,
          definition: expect.any(Object),
        },
      });
    } finally {
      await withE2eDb((q) => q.exec("DELETE FROM theme_packages WHERE id = ?", [packId]));
    }
  });

  test("实时撤权：自定义双资格管理员同令牌变为 403，授权快照不改", async ({ page, request }) => {
    const controller = await issueWriterToken(page, "实时撤权操作者", { roles: "write" });
    const holderId = await withE2eDb(async (q) => {
      const id = await createAuthorUser(q, `${TAG}-live-holder`);
      adminUserIds.push(id);
      // 令牌持有人须为可登录账号；只复制种子密码哈希，不复制角色。
      const account = await q.exec(
        "UPDATE users u JOIN users seed ON seed.id = ? SET u.password_hash = seed.password_hash, u.email_verified_at = NOW() WHERE u.id = ?",
        [USERS.admin, id],
      );
      expect(account.affectedRows).toBe(1);
      return id;
    });
    const roleKey = `rest-live-${TAG}`;
    const rolePath = `/api/manage/roles/${roleKey}`;
    const write = (method: string, path: string, data: object) =>
      request.fetch(path, {
        method,
        headers: { ...bearer(controller), "Idempotency-Key": randomUUID() },
        data,
      });

    try {
      // 持有人不绑内置 admin，只有自定义角色赋予 site.admin、admin.roles 和可撤的日志权限。
      const created = await write("POST", "/api/manage/roles", {
        key: roleKey,
        name: "实时授权持有人",
      });
      expect(created.status()).toBe(200);
      for (const permission of ["site.admin", "admin.roles", "admin.logs"]) {
        const grant = await write("PUT", `${rolePath}/grants/${permission}`, { scopeId: 0 });
        expect(grant.status()).toBe(200);
        expect(await grant.json()).toMatchObject({
          data: { permissionKey: permission, changed: true },
        });
      }
      const assigned = await write("PUT", `/api/manage/users/${holderId}/roles/${roleKey}`, {
        scopeId: 0,
        expiresAt: null,
        reason: "验收实时权限裁剪",
      });
      expect(assigned.status()).toBe(200);

      const tokenName = `${NAME_PREFIX}实时裁剪持有人`;
      tokenNames.push(tokenName);
      const token = await issueManageToken(
        page,
        tokenName,
        { identity: "read", stats: "read" },
        holderId,
      );
      const headers = bearer(token);
      const identity = {
        id: "whoami",
        method: "GET",
        path: "/api/manage/whoami",
        scope: "identity:read",
      };
      const stats = { id: "stats", method: "GET", path: "/api/manage/stats", scope: "stats:read" };
      type Grant = typeof identity;
      const whoami = async () => {
        const response = await request.get("/api/manage/whoami?include=token_permissions", {
          headers,
        });
        expect(response.status()).toBe(200);
        const body = (await response.json()) as {
          ok: boolean;
          data: {
            user: { id: number };
            token: { name: string; suffix: string };
            permissions: string[];
            tokenPermissions: { granted: Grant[]; effective: Grant[] };
          };
        };
        expect(body).toMatchObject({
          ok: true,
          data: { user: { id: holderId }, token: { name: tokenName, suffix: token.slice(-8) } },
        });
        return body.data;
      };
      expect((await request.get(stats.path, { headers })).status()).toBe(200);
      const before = await whoami();
      expect(before.permissions).toEqual(
        expect.arrayContaining(["site.admin", "admin.roles", "admin.logs"]),
      );
      expect(before.tokenPermissions.granted).toHaveLength(2);
      expect(before.tokenPermissions.granted).toEqual(expect.arrayContaining([identity, stats]));
      expect(before.tokenPermissions.effective).toEqual(before.tokenPermissions.granted);

      const revoked = await write("DELETE", `${rolePath}/grants/admin.logs`, { scopeId: 0 });
      expect(revoked.status()).toBe(200);
      expect(await revoked.json()).toEqual({
        ok: true,
        data: { roleKey, permissionKey: "admin.logs", scopeId: 0, changed: true },
      });
      await expectManageError(await request.get(stats.path, { headers }), 403, "forbidden");
      const after = await whoami();
      expect(after.permissions).toEqual(expect.arrayContaining(["site.admin", "admin.roles"]));
      expect(after.permissions).not.toContain("admin.logs");
      expect(after.tokenPermissions).toEqual({
        granted: before.tokenPermissions.granted,
        effective: [identity],
      });
      const tokenRow = await withE2eDb((q) =>
        q.query<{ revokedAt: string | null }>(
          "SELECT revoked_at AS revokedAt FROM admin_api_tokens WHERE id = ? AND user_id = ?",
          [createHash("sha256").update(token).digest("hex"), holderId],
        ),
      );
      expect(tokenRow).toEqual([{ revokedAt: null }]);
    } finally {
      await withE2eDb(async (q) => {
        await q.exec("DELETE FROM user_roles WHERE user_id = ? AND role_key = ?", [
          holderId,
          roleKey,
        ]);
        await q.exec("DELETE FROM role_grants WHERE role_key = ?", [roleKey]);
        await q.exec("DELETE FROM roles WHERE `key` = ?", [roleKey]);
      });
    }
  });

  test("新建专用管理员签发的令牌同样受矩阵约束", async ({ context, page, request }) => {
    const adminId = await withE2eDb((q) => createAdminUser(q, `${TAG}-extra`));
    adminUserIds.push(adminId);
    await loginAs(context, adminId);
    const name = `${NAME_PREFIX}专用管理员`;
    tokenNames.push(name);
    const token = await issueManageToken(page, name, { stats: "read" });

    expect((await request.get("/api/manage/stats", { headers: bearer(token) })).status()).toBe(200);
    await expectManageError(
      await request.get("/api/manage/users", { headers: bearer(token) }),
      403,
      "forbidden",
    );
    await expectWriteDenied(request, token);
  });
});
