// @vitest-environment node
import { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditLog,
  contentReviews,
  DEMO,
  eventOutbox,
  getWebDb,
  insertIdOf,
  manageApiIdempotency,
  posts,
  threads,
} from "@funwind/db";
import { GET as getContent } from "@/app/api/manage/contents/[id]/route";
import { POST as review } from "@/app/api/manage/posts/[postId]/review/route";
import { PUT as lock } from "@/app/api/manage/threads/[threadId]/lock/route";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { hashToken } from "@/lib/auth/token";
import { assignUserRole, createCustomRole, grantRolePermission } from "@/lib/authz/admin";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { insertLegacyToken, makeActiveUser, makeSiteAdmin } from "./int-fixtures";
import { createScopedAdminApiToken } from "./tokens";

const db = () => getWebDb();
const reviewForum = 906;
const editedAt = "2026-05-01 10:01:00";

async function seedThread(state: "pending" | "visible") {
  const common = { state, authorId: DEMO.member, createdAt: "2026-05-01 10:00:00" };
  const threadId = insertIdOf(
    await db()
      .insert(threads)
      .values({
        ...common,
        forumId: reviewForum,
        title: "管理写入夹具",
        firstPostId: 0,
      }),
  );
  const postId = insertIdOf(
    await db()
      .insert(posts)
      .values({
        ...common,
        threadId,
        floor: 1,
        bodyMd: "不应进入审计的正文",
        editedAt: state === "pending" ? editedAt : null,
      }),
  );
  await db().update(threads).set({ firstPostId: postId }).where(eq(threads.id, threadId));
  return { threadId, postId };
}

function issue(userId: number, level: "read" | "write" = "write") {
  return createScopedAdminApiToken({
    userId,
    name: "内容治理",
    days: 30,
    actor: { userId, via: "admin" },
    permissions: { contents: level },
  });
}

function writeRequest(
  method: "POST" | "PUT",
  path: string,
  plain: string,
  id: number,
  key: string,
  data: unknown,
) {
  const request = new NextRequest(`http://localhost/api/manage/${path}?secret=never-record-this`, {
    method,
    headers: {
      authorization: `Bearer ${plain}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(data),
  });
  const params = Promise.resolve({ [method === "PUT" ? "threadId" : "postId"]: String(id) });
  return { request, params };
}

function lockThread(plain: string, id: number, key: string, locked: boolean) {
  const { request, params } = writeRequest("PUT", `threads/${id}/lock`, plain, id, key, { locked });
  return lock(request, { params });
}

function reviewPost(plain: string, id: number, key: string, data: unknown) {
  const { request, params } = writeRequest("POST", `posts/${id}/review`, plain, id, key, data);
  return review(request, { params });
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ error: { code } });
}

const mutations = (targetId: number, action: string) =>
  db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.targetId, String(targetId)), eq(auditLog.action, action)));

const readIdempotency = (token: string, key: string) =>
  db()
    .select()
    .from(manageApiIdempotency)
    .where(
      and(
        eq(manageApiIdempotency.tokenId, token),
        eq(manageApiIdempotency.keyHash, hashToken(key)),
      ),
    );

let testDb: TempDb;

describe.skipIf(skipDb)("管理 REST 内容写入（真实 MySQL）", () => {
  beforeAll(async () => {
    testDb = await setupTempDb();
  });
  afterAll(async () => {
    await testDb?.teardown();
  });
  beforeEach(() => {
    resetRateLimiter();
    vi.stubEnv("MANAGE_API_WRITES", "on");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("历史和新版只读令牌不能写；停写不影响持有者读取", async () => {
    const uid = await makeSiteAdmin("manage_readonly");
    const { threadId } = await seedThread("visible");
    const legacy = await insertLegacyToken(uid);
    const read = await issue(uid, "read");
    const write = await issue(uid);
    expect(read.plain).toMatch(/^fw_at2_/);
    for (const token of [legacy, read]) {
      await expectError(
        await lockThread(token.plain, threadId, "test-read-only-key", true),
        403,
        "forbidden",
      );
    }
    vi.stubEnv("MANAGE_API_WRITES", "off");
    await expectError(
      await lockThread(write.plain, threadId, "test-stop-write-key", true),
      503,
      "writes_disabled",
    );
    const response = await getContent(
      new NextRequest(`http://localhost/api/manage/contents/${threadId}`, {
        headers: { authorization: `Bearer ${write.plain}` },
      }),
      { params: Promise.resolve({ id: String(threadId) }) },
    );
    expect(response.status).toBe(200);
  });

  it("并发同键只变更一次；回放不重写审计，冲突键不改变目标", async () => {
    const token = await issue(await makeSiteAdmin("manage_lock"));
    const { threadId } = await seedThread("visible");
    const key = "test-lock-replay-key";
    const call = (locked: boolean, k = key) => lockThread(token.plain, threadId, k, locked);
    const responses = await Promise.all([call(true), call(true)]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        data: { threadId, locked: true, changed: true },
      });
    }
    await expectError(await call(false), 409, "idempotency_conflict");
    const noop = await call(true, "test-lock-noop-key");
    expect(await noop.json()).toMatchObject({ data: { changed: false } });
    const unlocked = await call(false, "test-unlock-once-key");
    expect(await unlocked.json()).toMatchObject({ data: { locked: false, changed: true } });
    expect(await (await call(true)).json()).toMatchObject({ data: { locked: true } });
    expect((await db().select().from(threads).where(eq(threads.id, threadId)))[0].isLocked).toBe(
      false,
    );
    const audits = await mutations(threadId, "admin.thread.flags");
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      beforeJson: { isLocked: false },
      afterJson: {
        isLocked: true,
        via: "api",
        tokenSuffix: token.suffix,
        requestId: expect.any(String),
      },
    });
    const calls = await db().select().from(auditLog).where(eq(auditLog.action, "api.threads.lock"));
    expect(calls.some((row) => JSON.stringify(row.afterJson).includes("never-record-this"))).toBe(
      false,
    );
  });

  it("审核校验锁内编辑版本，成功后同键回放而不再发事件", async () => {
    const token = await issue(await makeSiteAdmin("manage_review"));
    const { threadId, postId } = await seedThread("pending");
    const path = `http://localhost/api/manage/contents/${threadId}`;
    const detail = await getContent(
      new NextRequest(path, { headers: { authorization: `Bearer ${token.plain}` } }),
      {
        params: Promise.resolve({ id: String(threadId) }),
      },
    );
    expect(await detail.json()).toMatchObject({ data: { firstPost: { postId, editedAt } } });
    const key = "test-review-version-key";
    const call = (expectedEditedAt: string | null, k = key) =>
      reviewPost(token.plain, postId, k, { decision: "approve", expectedEditedAt });
    await expectError(await call(null), 409, "state_conflict");
    expect(await readIdempotency(token.id, key)).toHaveLength(0);
    const result = await call(editedAt);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true, data: { postId, threadId, state: "visible" } });
    expect((await call(editedAt)).status).toBe(200);
    await expectError(await call(editedAt, "test-another-review-key"), 409, "state_conflict");
    expect(
      await db().select().from(contentReviews).where(eq(contentReviews.postId, postId)),
    ).toHaveLength(1);
    const events = await db()
      .select()
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.eventName, "content.moderated"),
          sql`JSON_EXTRACT(${eventOutbox.payload}, '$.postId') = ${postId}`,
        ),
      );
    expect(events).toHaveLength(1);
    const audits = await mutations(postId, "post.state.visible");
    expect(audits).toHaveLength(1);
    expect(audits[0].afterJson).toMatchObject({
      via: "api",
      tokenSuffix: token.suffix,
      requestId: expect.any(String),
    });
    expect(JSON.stringify(audits[0])).not.toContain("不应进入审计的正文");
  });

  it("目标不存在与目标版块越权不可区分", async () => {
    const uid = await makeActiveUser("manage_no_forum");
    const actor = { userId: DEMO.admin, ip: null };
    await createCustomRole(actor, "manage-no-forum", "无内容版主权", "测试");
    await grantRolePermission(actor, "manage-no-forum", "site.admin", 0);
    await grantRolePermission(actor, "manage-no-forum", "admin.roles", 0);
    await assignUserRole(actor, uid, "manage-no-forum", 0, null, "测试");
    const token = await issue(uid);
    const { postId } = await seedThread("pending");
    for (const id of [postId, 50000000]) {
      await expectError(
        await reviewPost(token.plain, id, "test-review-hidden-key", {
          decision: "reject",
          expectedEditedAt: editedAt,
          reason: "测试",
        }),
        404,
        "not_found",
      );
    }
  });

  it("过期键不回放；授权调用可以按当前状态重新执行", async () => {
    const token = await issue(await makeSiteAdmin("manage_expired_key"));
    const { threadId } = await seedThread("visible");
    const key = "test-expired-lock-key";
    const call = (locked: boolean) => lockThread(token.plain, threadId, key, locked);
    expect((await call(true)).status).toBe(200);
    const [stored] = await readIdempotency(token.id, key);
    await db()
      .update(manageApiIdempotency)
      .set({ expiresAt: sql`NOW() - INTERVAL 1 SECOND` })
      .where(
        and(
          eq(manageApiIdempotency.tokenId, token.id),
          eq(manageApiIdempotency.keyHash, stored.keyHash),
        ),
      );
    const response = await call(false);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { locked: false, changed: true } });
    expect(await mutations(threadId, "admin.thread.flags")).toHaveLength(2);
  });

  it("outbox 故障回滚审核、台账和审计，同键修复后可重试", async () => {
    const token = await issue(await makeSiteAdmin("manage_rollback"));
    const { postId } = await seedThread("pending");
    const key = "test-rollback-outbox-key";
    const call = () =>
      reviewPost(token.plain, postId, key, {
        decision: "reject",
        expectedEditedAt: editedAt,
        reason: "需补材料",
      });
    // 此触发器只在测试套件自己的随机临时库中模拟 outbox 写失败。
    await db().execute(
      sql`CREATE TRIGGER fail_manage_review_outbox BEFORE INSERT ON event_outbox FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '测试回滚'`,
    );
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expectError(await call(), 500, "internal");
      expect(JSON.stringify(stderr.mock.calls)).not.toContain("需补材料");
      expect(await readIdempotency(token.id, key)).toHaveLength(0);
      expect(await mutations(postId, "post.state.rejected")).toHaveLength(0);
      expect((await db().select().from(posts).where(eq(posts.id, postId)))[0].state).toBe(
        "pending",
      );
    } finally {
      stderr.mockRestore();
      await db().execute(sql`DROP TRIGGER fail_manage_review_outbox`);
    }
    expect((await call()).status).toBe(200);
  });
});
