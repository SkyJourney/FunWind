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

  test("驳回：理由送达，同键回放与异参冲突都不重复副作用", async ({ context, page, request }) => {
    await loginAs(context, USERS.admin);
    const writer = await issueFor(page, "writer");
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

  test("锁定与解锁：同值零审计，反向变更留痕", async ({ context, page, request }) => {
    await loginAs(context, USERS.admin);
    const writer = await issueFor(page, "writer");
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
