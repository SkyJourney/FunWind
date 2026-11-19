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
