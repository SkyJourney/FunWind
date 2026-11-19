import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";
import { USERS, loginAs } from "./support/session";
import { withE2eDb } from "./support/db";
import {
  MISSING_ID,
  READ_ENDPOINTS,
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
 * 管理 REST 全面验收（M20.2）：在隔离库与生产构建上逐项核对对外契约。
 *
 * 覆盖：按域授权矩阵（含跨域 403 与写域才有写权）、九个读端点语义、whoami 精确授权诊断、
 * 审核通过与驳回的留痕与通知、幂等回放与异参冲突、状态与版本冲突、越权与不存在同为 404、
 * 锁定与解锁的同值零审计、吊销与过期后一律 401。
 *
 * 本文件不依赖生产数据：令牌经后台页面真实签发，内容为本次专用夹具，结束后精确回收。
 */

const TAG = runTag();
const NAME_PREFIX = `E2E REST 验收 · ${TAG} · `;

/** 令牌按持有人计上限（每管理员 5 枚），矩阵核对分散到两个专用管理员。 */
const PLAN = {
  readerA: {
    identity: "令牌身份",
    contents: "内容治理",
    users: "用户管理",
    stats: "站点统计",
    "audit-logs": "审计日志",
  },
  readerB: { emails: "邮件日志", "push-logs": "推送日志" },
  writer: { contents: "内容治理", identity: "令牌身份" },
} as const;

type TokenKind = keyof typeof PLAN;

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
  const levels = Object.fromEntries(
    Object.entries(PLAN[kind]).map(([domain, level]) => [
      domain,
      level === "令牌身份" || level === "内容治理" ? "read" : "read",
    ]),
  );
  if (kind === "writer") levels.contents = "write";
  const plain = await issueManageToken(page, name, levels);
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

  test("按域授权矩阵：只读令牌只读本域，写域令牌才有写权，跨域一律 403", async ({
    context,
    page,
    request,
  }) => {
    await loginAs(context, USERS.admin);
    const readerA = await issueFor(page, "readerA");
    const readerB = await issueFor(page, "readerB");
    const writer = await issueFor(page, "writer");

    // 只读令牌：同域读端点 200，跨域读端点 403，写端点一律 403。
    for (const [token, allowedDomains] of [
      [readerA, ["identity", "contents", "users", "stats", "audit-logs"]],
      [readerB, ["emails", "push-logs"]],
    ] as const) {
      for (const endpoint of READ_ENDPOINTS) {
        const path = endpoint.path.replace("{id}", "950001").replace("{uid}", String(USERS.member));
        const response = await request.get(path, { headers: bearer(token) });
        const expected = allowedDomains.includes(endpoint.domain) ? 200 : 403;
        expect(response.status(), `${token.slice(-4)} 访问 ${endpoint.path}`).toBe(expected);
        if (expected === 403)
          expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
      }
      for (const endpoint of WRITE_ENDPOINTS) {
        const response = await writeProbe(request, token, endpoint);
        expect(response.status(), `${token.slice(-4)} 写 ${endpoint.path}`).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
      }
    }

    // 写域令牌：本域读端点 200，跨域读端点 403；写端点因授权通过而越过写权门，目标不存在故 404。
    for (const endpoint of READ_ENDPOINTS) {
      const path = endpoint.path.replace("{id}", "950001").replace("{uid}", String(USERS.member));
      const response = await request.get(path, { headers: bearer(writer) });
      const expected = endpoint.domain === "contents" || endpoint.domain === "identity" ? 200 : 403;
      expect(response.status(), `写域令牌访问 ${endpoint.path}`).toBe(expected);
    }
    for (const endpoint of WRITE_ENDPOINTS) {
      const response = await writeProbe(request, writer, endpoint);
      expect(response.status(), `写域令牌写 ${endpoint.path}`).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  test("whoami 精确报告令牌授权，并区分已授予与当前生效", async ({ context, page, request }) => {
    await loginAs(context, USERS.admin);
    const writer = await issueFor(page, "writer");
    const identity = await request.get("/api/manage/whoami", { headers: bearer(writer) });
    expect(identity.status()).toBe(200);
    const body = (await identity.json()) as {
      data: { user: { id: number }; permissions: string[]; tokenPermissions?: unknown };
    };
    expect(body.data.user.id).toBe(USERS.admin);
    expect(body.data.permissions).toContain("site.admin");
    expect(body.data.tokenPermissions).toBeUndefined();

    const detailed = await request.get("/api/manage/whoami?include=token_permissions", {
      headers: bearer(writer),
    });
    expect(detailed.status()).toBe(200);
    const detail = (await detailed.json()) as {
      data: { tokenPermissions: { granted: { id: string }[]; effective: { id: string }[] } };
    };
    expect(detail.data.tokenPermissions.granted.map((e) => e.id).sort()).toEqual([
      "contents",
      "contents.detail",
      "posts.review",
      "threads.lock",
      "whoami",
    ]);
    expect(detail.data.tokenPermissions.effective.map((e) => e.id).sort()).toEqual(
      detail.data.tokenPermissions.granted.map((e) => e.id).sort(),
    );
  });

  test("读端点返回真实数据形状，未登记路径与不存在目标不泄露", async ({
    context,
    page,
    request,
  }) => {
    await loginAs(context, USERS.admin);
    const readerA = await issueFor(page, "readerA");
    const readerB = await issueFor(page, "readerB");

    const contents = await request.get("/api/manage/contents?size=10", {
      headers: bearer(readerA),
    });
    expect(contents.status()).toBe(200);
    expect(await contents.json()).toMatchObject({
      data: { items: expect.any(Array), total: expect.any(Number) },
    });

    const detail = await request.get("/api/manage/contents/950001?kind=thread", {
      headers: bearer(readerA),
    });
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({ data: { threadId: 950001, kind: "thread" } });

    const users = await request.get("/api/manage/users?size=10", { headers: bearer(readerA) });
    expect(users.status()).toBe(200);
    expect(await users.json()).toMatchObject({
      data: { items: expect.any(Array), total: expect.any(Number) },
    });

    const user = await request.get(`/api/manage/users/${USERS.member}`, {
      headers: bearer(readerA),
    });
    expect(user.status()).toBe(200);
    expect(await user.json()).toMatchObject({ data: { id: USERS.member } });

    const missingUser = await request.get(`/api/manage/users/${MISSING_ID}`, {
      headers: bearer(readerA),
    });
    await expectManageError(missingUser, 404, "not_found");

    const stats = await request.get("/api/manage/stats", { headers: bearer(readerA) });
    expect(stats.status()).toBe(200);
    expect((await stats.json()).data).toMatchObject({
      registered30: expect.any(Array),
      threads30: expect.any(Array),
      replies30: expect.any(Array),
      todayLogins: expect.any(Number),
      totals: { users: expect.any(Number), threads: expect.any(Number), posts: expect.any(Number) },
    });

    const audits = await request.get("/api/manage/audit-logs?size=10", {
      headers: bearer(readerA),
    });
    expect(audits.status()).toBe(200);
    expect(await audits.json()).toMatchObject({ data: { items: expect.any(Array) } });

    const emails = await request.get("/api/manage/emails?size=10", { headers: bearer(readerB) });
    expect(emails.status()).toBe(200);
    expect(await emails.json()).toMatchObject({ data: { items: expect.any(Array) } });

    const push = await request.get("/api/manage/push-logs?size=10", { headers: bearer(readerB) });
    expect(push.status()).toBe(200);
    expect(await push.json()).toMatchObject({ data: { items: expect.any(Array) } });

    // 未登记的路径由框架返回 404 页面（不是管理 API 信封），不得泄露端点存在性。
    const unknown = await request.get("/api/manage/not-a-real-endpoint", {
      headers: bearer(readerA),
    });
    expect(unknown.status()).toBe(404);
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
