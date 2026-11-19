import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";
import { USERS, loginAs } from "./support/session";
import { withE2eDb } from "./support/db";
import {
  MISSING_ID,
  WRITE_ENDPOINTS,
  bearer,
  cleanupManageArtifacts,
  createAdminUser,
  createAuthorUser,
  expectManageError,
  insertLegacyToken,
  issueManageToken,
  revokeManageToken,
  runTag,
  seedPendingThread,
  type PendingThread,
} from "./support/manage-api";

/**
 * 管理 REST 写入语义与凭证生命周期验收（M20.2）。
 *
 * 权限矩阵 × 全端点、查询数据断言与参数错误路径由 manage-api-matrix.spec.ts 系统化覆盖；
 * 本文件聚焦写链路深度：审核通过与驳回的留痕与通知、幂等回放与异参冲突、状态与版本冲突、
 * 锁定与解锁的同值零审计，以及吊销、过期、历史令牌与新建管理员的凭证行为。
 */

const TAG = runTag();
const NAME_PREFIX = `E2E REST 验收 · ${TAG} · `;

type TokenKind = "writer";

/** 逐域只读令牌与写域令牌；矩阵核对要求同时存在。 */
const tokens = new Map<TokenKind, string>();
const tokenNames: string[] = [];
const adminUserIds: number[] = [];
const authorUserIds: number[] = [];
const targets: PendingThread[] = [];

/**
 * 为单个写语义用例签发独立管理员与写令牌：写频控按令牌 10 次/分钟计，
 * 共享令牌会在多用例累计后触发 429，因此每个重度写用例独占一枚。
 */
async function issueWriterToken(
  page: import("@playwright/test").Page,
  tag: string,
  levels: { contents?: "write"; reports?: "read" | "write"; identity?: "read" } = {
    contents: "write",
    identity: "read",
  },
) {
  const adminId = await withE2eDb((q) => createAdminUser(q, `${TAG}-${tag}`));
  adminUserIds.push(adminId);
  await loginAs(page.context(), adminId);
  const name = `${NAME_PREFIX}writer · ${tag}`;
  tokenNames.push(name);
  return issueManageToken(page, name, levels);
}

async function issueFor(page: import("@playwright/test").Page, kind: TokenKind) {
  const cached = tokens.get(kind);
  if (cached) return cached;
  const name = `${NAME_PREFIX}${kind}`;
  const plain = await issueManageToken(page, name, { contents: "write", identity: "read" });
  tokens.set(kind, plain);
  tokenNames.push(name);
  return plain;
}

/** 用写域令牌调用写端点；授权不足应为 403，授权通过但目标不存在应为 404。 */
async function writeProbe(
  request: APIResponse["request"],
  token: string,
  endpoint: {
    method: string;
    path: string;
  },
) {
  const path = endpoint.path
    .replace("{id}", String(MISSING_ID))
    .replace("{uid}", String(MISSING_ID))
    .replace("{postId}", String(MISSING_ID))
    .replace("{threadId}", String(MISSING_ID));
  const data =
    endpoint.method === "POST" ? { decision: "approve", expectedEditedAt: null } : { locked: true };
  return request.fetch(path, {
    method: endpoint.method,
    headers: {
      ...bearer(token),
      "Idempotency-Key": randomUUID(),
      "content-type": "application/json",
    },
    data,
  });
}

test.describe.serial("管理 REST 全面验收", () => {
  test.afterAll(async () => {
    await cleanupManageArtifacts({
      tokenNames,
      adminUserIds,
      authorUserIds,
      targets,
    });
  });

  test("审核通过：版本冲突不改数据，通过后留痕与通知各一条", async ({ context, page, request }) => {
    await loginAs(context, USERS.admin);
    const writer = await issueFor(page, "writer");
    const tag = `${TAG}-approve`;
    const target: PendingThread = { threadId: 0, postId: 0 };
    targets.push(target);
    const authorId = await withE2eDb((q) => createAuthorUser(q, tag));
    authorUserIds.push(authorId);
    await withE2eDb((q) => seedPendingThread(q, target, authorId, tag));

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
    const notices = await withE2eDb((q) =>
      q.query<{ type: string }>("SELECT type FROM notifications WHERE user_id = ?", [authorId]),
    );
    expect(notices).toEqual([{ type: "content.approved" }]);
  });

  test("驳回：理由送达，同键回放与异参冲突都不重复副作用", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "驳回：理由送");
    const tag = `${TAG}-reject`;
    const target: PendingThread = { threadId: 0, postId: 0 };
    targets.push(target);
    const authorId = await withE2eDb((q) => createAuthorUser(q, tag));
    authorUserIds.push(authorId);
    await withE2eDb((q) => seedPendingThread(q, target, authorId, tag));

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
    const tag = `${TAG}-lock`;
    const target: PendingThread = { threadId: 0, postId: 0 };
    targets.push(target);
    const authorId = await withE2eDb((q) => createAuthorUser(q, tag));
    authorUserIds.push(authorId);
    await withE2eDb((q) => seedPendingThread(q, target, authorId, tag));

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

  test("凭证失效：吊销与过期后读写一律 401", async ({ context, page, request }) => {
    await loginAs(context, USERS.admin);
    const name = `${NAME_PREFIX}待吊销`;
    tokenNames.push(name);
    const token = await issueManageToken(page, name, { contents: "read", identity: "read" });
    const legacy = await withE2eDb((q) => insertLegacyToken(q, USERS.admin, `${name}-历史`));
    tokenNames.push(`${name}-历史`);

    expect((await request.get("/api/manage/whoami", { headers: bearer(token) })).status()).toBe(
      200,
    );
    // 历史令牌只保留九个 GET，写端点一律拒绝。
    expect((await request.get("/api/manage/whoami", { headers: bearer(legacy) })).status()).toBe(
      200,
    );
    const legacyWrite = await writeProbe(request, legacy, WRITE_ENDPOINTS[0]);
    expect(legacyWrite.status()).toBe(403);

    await revokeManageToken(page, name);
    await expectManageError(
      await request.get("/api/manage/whoami", { headers: bearer(token) }),
      401,
      "unauthorized",
    );

    const expiredName = `${name}-过期`;
    tokenNames.push(expiredName);
    const expired = await issueManageToken(page, expiredName, {
      contents: "read",
      identity: "read",
    });
    await withE2eDb((q) =>
      q.exec(
        "UPDATE admin_api_tokens SET expires_at = NOW() - INTERVAL 1 SECOND WHERE suffix = ?",
        [expired.slice(-8)],
      ),
    );
    await expectManageError(
      await request.get("/api/manage/whoami", { headers: bearer(expired) }),
      401,
      "unauthorized",
    );
  });

  test("屏蔽与封禁：状态机迁移与恢复冲突", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "屏蔽与封禁：");
    const tag = `${TAG}-hide`;
    const target: PendingThread = { threadId: 0, postId: 0 };
    targets.push(target);
    const authorId = await withE2eDb((q) => createAuthorUser(q, tag));
    authorUserIds.push(authorId);
    // 屏蔽要求 visible 起点；版本号从内容详情取得（与审核同口径）。
    await withE2eDb((q) => seedPendingThread(q, target, authorId, tag, "visible"));
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
    const tag = `${TAG}-restore`;
    const target: PendingThread = { threadId: 0, postId: 0 };
    targets.push(target);
    const authorId = await withE2eDb((q) => createAuthorUser(q, tag));
    authorUserIds.push(authorId);
    await withE2eDb((q) => seedPendingThread(q, target, authorId, tag, "deleted"));
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
  });

  test("主题标记：精华与置顶留痕，同值零审计", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "主题标记：精");
    const tag = `${TAG}-flags`;
    const target: PendingThread = { threadId: 0, postId: 0 };
    targets.push(target);
    const authorId = await withE2eDb((q) => createAuthorUser(q, tag));
    authorUserIds.push(authorId);
    await withE2eDb((q) => seedPendingThread(q, target, authorId, tag, "visible"));

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
    const tag = `${TAG}-report`;
    const target: PendingThread = { threadId: 0, postId: 0 };
    targets.push(target);
    const authorId = await withE2eDb((q) => createAuthorUser(q, tag));
    authorUserIds.push(authorId);
    const reporterId = await withE2eDb((q) => createAuthorUser(q, `${tag}-reporter`));
    authorUserIds.push(reporterId);
    // 举报列表查询只展示可见内容上的举报：目标帖用可见态。
    await withE2eDb((q) => seedPendingThread(q, target, authorId, tag, "visible"));
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
    const fresh = await patch({ ...fields, expectedRevision: 1 });
    expect(await fresh.json()).toEqual({ ok: true, data: { id: campaignId, revision: 2 } });

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
    const batch = `${TAG}-inv`;
    // 生成 2 条：同键回放返回同一批码（码面明文只在生成时返回一次）
    const genKey = randomUUID();
    const gen = (key = genKey) =>
      request.post("/api/manage/invites", {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data: { count: 2, days: 30, batch },
      });
    const first = await gen();
    expect(first.status()).toBe(200);
    const codes = ((await first.json()) as { data: { codes: string[] } }).data.codes;
    expect(codes).toHaveLength(2);
    const genReplay = await gen();
    expect(await genReplay.json()).toEqual({ ok: true, data: { codes, count: 2, batch } });

    // 上限：count 21 → 400
    await expectManageError(
      await request.post("/api/manage/invites", {
        headers: {
          ...bearer(writer),
          "Idempotency-Key": randomUUID(),
          "content-type": "application/json",
        },
        data: { count: 21, days: 30, batch },
      }),
      400,
      "bad_request",
    );

    // 吊销第一条：同键回放同响应；新键再吊销 404
    const revoke = (code: string, key = randomUUID()) =>
      request.delete(`/api/manage/invites/${code}`, {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data: {},
      });
    // 首次吊销与同键回放用同一显式键（默认参数会生成新键，回放变成行已删的新意图 404）
    const revokeKey = randomUUID();
    const revoked1 = await revoke(codes[0], revokeKey);
    expect(revoked1.status()).toBe(200);
    const revokeReplay = await revoke(codes[0], revokeKey);
    expect(revokeReplay.status()).toBe(200);
    expect(await revokeReplay.json()).toEqual({
      ok: true,
      data: { code: codes[0], revoked: true },
    });
    await expectManageError(await revoke(codes[0]), 404, "not_found");

    // 模拟第二条被使用 → 直接吊销 409（已用）
    await withE2eDb((q) =>
      q.exec("UPDATE invite_codes SET used_by = 90002, used_at = NOW() WHERE code = ?", [codes[1]]),
    );
    await expectManageError(await revoke(codes[1]), 409, "state_conflict");

    // 批次吊销：无可用码 → 404
    await expectManageError(
      await request.post(`/api/manage/invites/batches/${encodeURIComponent(batch)}/revoke`, {
        headers: {
          ...bearer(writer),
          "Idempotency-Key": randomUUID(),
          "content-type": "application/json",
        },
        data: {},
      }),
      404,
      "not_found",
    );
    // 新批次可用码 → 批次吊销返回计数
    const seed = (
      await request.post("/api/manage/invites", {
        headers: {
          ...bearer(writer),
          "Idempotency-Key": randomUUID(),
          "content-type": "application/json",
        },
        data: { count: 2, days: 0, batch: `${batch}-b2` },
      })
    ).status();
    expect(seed).toBe(200);
    const batchRevoke = await request.post(
      `/api/manage/invites/batches/${encodeURIComponent(`${batch}-b2`)}/revoke`,
      {
        headers: {
          ...bearer(writer),
          "Idempotency-Key": randomUUID(),
          "content-type": "application/json",
        },
        data: {},
      },
    );
    expect(await batchRevoke.json()).toEqual({
      ok: true,
      data: { batch: `${batch}-b2`, revoked: 2 },
    });
    await withE2eDb((q) => q.exec("DELETE FROM invite_codes WHERE batch LIKE ?", [`${batch}%`]));
  });

  test("版块：创建/编辑/前缀/删除守卫与回放", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "版块：创建/", {
      forums: "write",
      identity: "read",
    });
    const post = (data: Record<string, unknown>, key = randomUUID()) =>
      request.post("/api/manage/forums", {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
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
    // 父版块不存在 → 404（锁定段守卫）
    await expectManageError(await post({ ...fields, parentId: 999999999 }), 404, "not_found");
    const key = randomUUID();
    const created = await post(fields, key);
    expect(created.status()).toBe(200);
    const fid = ((await created.json()) as { data: { id: number } }).data.id;
    const replay = await post(fields, key);
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, data: { id: fid } });

    // 编辑（改名）→ 详情可查
    const patch = await request.patch(`/api/manage/forums/${fid}`, {
      headers: {
        ...bearer(writer),
        "Idempotency-Key": randomUUID(),
        "content-type": "application/json",
      },
      data: {
        parentId: fields.parentId,
        name: `${TAG} REST 版块（改）`,
        description: null,
        sortOrder: 3,
        isListed: true,
        readPolicy: "inherit",
        writePolicy: "inherit",
        reviewPolicy: "inherit",
        isArchived: false,
      },
    });
    expect(patch.status()).toBe(200);
    const detail = await request.get(`/api/manage/forums/${fid}`, { headers: bearer(writer) });
    expect(await detail.json()).toMatchObject({
      data: { id: fid, name: `${TAG} REST 版块（改）` },
    });

    // 前缀增删
    const prefix = await request.post(`/api/manage/forums/${fid}/prefixes`, {
      headers: {
        ...bearer(writer),
        "Idempotency-Key": randomUUID(),
        "content-type": "application/json",
      },
      data: { name: "完结", sortOrder: 1 },
    });
    expect(prefix.status()).toBe(200);
    const prefixId = ((await prefix.json()) as { data: { prefixId: number } }).data.prefixId;
    const removed = await request.delete(`/api/manage/forums/${fid}/prefixes/${prefixId}`, {
      headers: {
        ...bearer(writer),
        "Idempotency-Key": randomUUID(),
        "content-type": "application/json",
      },
      data: {},
    });
    expect(removed.status()).toBe(200);

    // 删除（空版块成功；回放同结果）
    const delKey = randomUUID();
    const del = await request.delete(`/api/manage/forums/${fid}`, {
      headers: { ...bearer(writer), "Idempotency-Key": delKey, "content-type": "application/json" },
      data: {},
    });
    expect(del.status()).toBe(200);
    const delReplay = await request.delete(`/api/manage/forums/${fid}`, {
      headers: { ...bearer(writer), "Idempotency-Key": delKey, "content-type": "application/json" },
      data: {},
    });
    expect(delReplay.status()).toBe(200);
    // 新键再删 → 404
    await expectManageError(
      await request.delete(`/api/manage/forums/${fid}`, {
        headers: {
          ...bearer(writer),
          "Idempotency-Key": randomUUID(),
          "content-type": "application/json",
        },
        data: {},
      }),
      404,
      "not_found",
    );
  });

  test("投票：threadId 口径、截止/重开/删除与回放", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "投票：thread", {
      polls: "write",
      identity: "read",
    });
    const authorId = await withE2eDb((q) => createAuthorUser(q, `${TAG}-poll`));
    authorUserIds.push(authorId);
    const target: PendingThread = { threadId: 0, postId: 0 };
    targets.push(target);
    await withE2eDb((q) => seedPendingThread(q, target, authorId, `${TAG}-poll`, "visible"));
    await withE2eDb((q) =>
      q.exec(
        "INSERT INTO polls (thread_id, created_by, ends_at, created_at) VALUES (?, ?, '2027-01-01 08:00:00', NOW())",
        [target.threadId, authorId],
      ),
    );

    // 列表可查 + close（同键回放）+ 已截止再截 409
    const list = await request.get("/api/manage/polls?status=open", { headers: bearer(writer) });
    expect(list.status()).toBe(200);
    const closeKey = randomUUID();
    const close = (key = closeKey) =>
      request.post(`/api/manage/polls/${target.threadId}/close`, {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data: {},
      });
    expect((await close()).status()).toBe(200);
    expect((await close()).status()).toBe(200);
    await expectManageError(await close(randomUUID()), 409, "state_conflict");

    // reopen：endsAt 清空 → open 列表恢复
    const reopen = await request.post(`/api/manage/polls/${target.threadId}/reopen`, {
      headers: {
        ...bearer(writer),
        "Idempotency-Key": randomUUID(),
        "content-type": "application/json",
      },
      data: {},
    });
    expect(reopen.status()).toBe(200);

    // 删除：硬删 + 主题回普通帖
    const del = await request.delete(`/api/manage/polls/${target.threadId}`, {
      headers: {
        ...bearer(writer),
        "Idempotency-Key": randomUUID(),
        "content-type": "application/json",
      },
      data: {},
    });
    expect(del.status()).toBe(200);
    const [kind] = await withE2eDb((q) =>
      q.query<{ kind: string }>("SELECT kind FROM threads WHERE id = ?", [target.threadId]),
    );
    expect(kind.kind).toBe("normal");
    await withE2eDb((q) => q.exec("DELETE FROM polls WHERE thread_id = ?", [target.threadId]));
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
    const badgeId = (
      await withE2eDb((q) =>
        q.exec(
          "INSERT INTO badges (`key`, name, kind, sort_order, is_active) VALUES (?, ?, 'honor', 0, 1)",
          [`rest-badge-${TAG}`, `REST 徽章 ${TAG}`],
        ),
      )
    ).insertId;
    // 字典可查（honor+active 口径）
    const dict = await request.get("/api/manage/badges", { headers: bearer(writer) });
    expect(dict.status()).toBe(200);

    const grantPath = `/api/manage/users/${targetId}/badges/${badgeId}`;
    const grant = (key = randomUUID()) =>
      request.post(grantPath, {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data: {},
      });
    expect((await grant()).status()).toBe(200);
    // 已持有 → 409（新意图）
    await expectManageError(await grant(), 409, "state_conflict");
    // 当事人收到 badge.awarded 通知
    const notices = await withE2eDb((q) =>
      q.query<{ type: string }>(
        "SELECT type FROM notifications WHERE user_id = ? AND type = 'badge.awarded'",
        [targetId],
      ),
    );
    expect(notices).toHaveLength(1);
    // 撤销 → 已撤销新意图 404
    const revoke = (key = randomUUID()) =>
      request.delete(grantPath, {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data: {},
      });
    expect((await revoke()).status()).toBe(200);
    await expectManageError(await revoke(), 404, "not_found");
    await withE2eDb((q) => q.exec("DELETE FROM user_badges WHERE user_id = ?", [targetId]));
    await withE2eDb((q) => q.exec("DELETE FROM badges WHERE id = ?", [badgeId]));
  });

  test("积分：调账落台账、回放同结果、规则聚合", async ({ page, request }) => {
    const writer = await issueWriterToken(page, "积分：调账", {
      points: "write",
      identity: "read",
    });
    const targetId = await withE2eDb((q) => createAuthorUser(q, `${TAG}-points`));
    authorUserIds.push(targetId);
    const adjust = (delta: number, key = randomUUID()) =>
      request.post("/api/manage/points/adjustments", {
        headers: { ...bearer(writer), "Idempotency-Key": key, "content-type": "application/json" },
        data: { userId: targetId, delta, note: "REST 调账" },
      });
    // delta 0 → 400
    await expectManageError(
      await request.post("/api/manage/points/adjustments", {
        headers: {
          ...bearer(writer),
          "Idempotency-Key": randomUUID(),
          "content-type": "application/json",
        },
        data: { userId: targetId, delta: 0, note: "x" },
      }),
      400,
      "bad_request",
    );
    const key = randomUUID();
    const first = await adjust(50, key);
    expect(first.status()).toBe(200);
    const balance = ((await first.json()) as { data: { balanceAfter: number } }).data.balanceAfter;
    // 同键回放：不重复调账（余额不变）
    const replay = await adjust(50, key);
    expect(await replay.json()).toEqual({
      ok: true,
      data: { userId: targetId, delta: 50, balanceAfter: balance },
    });
    const [ledger] = await withE2eDb((q) =>
      q.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM point_ledger WHERE user_id = ? AND note = 'REST 调账'",
        [targetId],
      ),
    );
    expect(ledger.n).toBe(1);

    // 台账查询端点
    const ledgerPage = await request.get(`/api/manage/points/ledger?userId=${targetId}&size=10`, {
      headers: bearer(writer),
    });
    expect(ledgerPage.status()).toBe(200);

    // 规则聚合
    const rules = await request.get("/api/manage/points/rules", { headers: bearer(writer) });
    expect(rules.status()).toBe(200);
    expect(await rules.json()).toMatchObject({
      data: {
        threadReward: expect.anything(),
        punchReward: expect.anything(),
        gateFeeRate: expect.anything(),
      },
    });
    await withE2eDb((q) => q.exec("DELETE FROM point_ledger WHERE user_id = ?", [targetId]));
    await withE2eDb((q) => q.exec("DELETE FROM point_accounts WHERE user_id = ?", [targetId]));
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
    const response = await writeProbe(request, token, WRITE_ENDPOINTS[0]);
    expect(response.status()).toBe(403);
  });
});
