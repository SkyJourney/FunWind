// @vitest-environment node
import "@/modules";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  adminApiTokens,
  auditLog,
  DEMO,
  eventOutbox,
  getWebDb,
  manageApiIdempotency,
  roleGrants,
  roles,
  userRoles,
} from "@funwind/db";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT as putRoleGrant } from "@/app/api/manage/roles/[roleKey]/grants/[permission]/route";
import { POST as postRole } from "@/app/api/manage/roles/route";
import { PUT as putUserRole } from "@/app/api/manage/users/[uid]/roles/[roleKey]/route";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { hashToken } from "@/lib/auth/token";
import { nowBeijingWallTime } from "@/lib/datetime";
import { authenticateManageRequest } from "@/lib/manage/guard";
import { insertLegacyToken, makeActiveUser } from "@/lib/manage/int-fixtures";
import type { ManageHandlerContext } from "@/lib/manage/route";
import { commitManageRoleWrite, createManageRole } from "@/lib/manage/system-writes";
import { createScopedAdminApiToken, revokeAdminApiToken } from "@/lib/manage/tokens";
import type { CreatedAdminApiToken } from "@/lib/manage/tokens";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  assignUserRole,
  createCustomRole,
  deleteCustomRole,
  grantRolePermission,
  prepareApiRoleCreate,
  prepareApiRoleDelete,
  prepareApiRoleGrant,
  prepareApiRoleRevoke,
  prepareApiUserRoleAssign,
  prepareApiUserRoleRevoke,
  setRolePublic,
} from "./admin";
import { isLastPermanentSiteAdmin, lockSiteAdminInvariant } from "./site-admin-invariant";
import { getAuthzSnapshot, invalidateAuthzSnapshot } from "./snapshot";

const actor = { userId: DEMO.admin, ip: "203.0.113.5", via: "api" };
const requestId = "roles-int";
let credential: CreatedAdminApiToken;
let trace: { requestId: string; tokenSuffix: string };
const db = () => getWebDb();
const reason = "调整测试角色";
const teamRole = "team-subtitle";

/** 用生产签发服务创建覆盖角色六写的凭证。 */
function issueRoleToken(userId: number) {
  return createScopedAdminApiToken({
    userId,
    name: "角色集成测试",
    days: 30,
    actor: { userId, via: "admin" },
    permissions: { roles: "write" },
  });
}

/** 先走真实凭证门禁；需控制业务准备阶段的用例再直接调用适配层。 */
async function makeContext(issued = credential): Promise<ManageHandlerContext> {
  const request = new NextRequest("http://localhost/api/manage/roles", {
    headers: { authorization: `Bearer ${issued.plain}` },
  });
  return {
    request,
    ...(await authenticateManageRequest(request)),
    ip: actor.ip,
    params: Promise.resolve({}),
    requestId,
  };
}

/** 使用角色写适配层，将角色键放入真实幂等请求指纹。 */
function commitRoleWrite(
  ctx: ManageHandlerContext,
  endpoint: Parameters<typeof commitManageRoleWrite>[1],
  input: Record<string, unknown>,
  operation: Parameters<typeof commitManageRoleWrite>[3],
  idempotencyKey: string = randomUUID(),
  targetId = 0,
) {
  return commitManageRoleWrite(ctx, endpoint, { targetId, input, idempotencyKey }, operation);
}

async function idempotencyRows(token: { id: string }, key: string) {
  return db()
    .select()
    .from(manageApiIdempotency)
    .where(
      and(
        eq(manageApiIdempotency.tokenId, token.id),
        eq(manageApiIdempotency.keyHash, hashToken(key)),
      ),
    );
}

async function roleRows(roleKey: string) {
  return {
    roles: await db().select().from(roles).where(eq(roles.key, roleKey)),
    grants: await db().select().from(roleGrants).where(eq(roleGrants.roleKey, roleKey)),
    bindings: await db().select().from(userRoles).where(eq(userRoles.roleKey, roleKey)),
  };
}

async function sideEffects() {
  return {
    audit: await db().select().from(auditLog).orderBy(auditLog.id),
    outbox: await db().select().from(eventOutbox).orderBy(eventOutbox.id),
  };
}

/** 由独立连接探测当前事务是否持有目标角色的排他锁，不依赖休眠或计时。 */
async function expectRoleRowLocked(roleKey: string) {
  await expect(
    db().transaction((tx) =>
      tx.select({ key: roles.key }).from(roles).where(eq(roles.key, roleKey)).for("update", {
        noWait: true,
      }),
    ),
  ).rejects.toMatchObject({ cause: { code: "ER_LOCK_NOWAIT" } });
}

async function seedAdminRole(roleKey: string, userId: number) {
  const backend = { userId: actor.userId, ip: null };
  await createCustomRole(backend, roleKey, roleKey, "");
  await grantRolePermission(backend, roleKey, "site.admin", 0);
  await grantRolePermission(backend, roleKey, "admin.roles", 0);
  await grantRolePermission(backend, roleKey, "admin.users", 0);
  await assignUserRole(backend, userId, roleKey, 0, null, reason);
}

const revocations = [
  {
    endpoint: "roles.delete",
    input: (roleKey: string) => ({ roleKey }),
    prepare: (roleKey: string) => prepareApiRoleDelete(actor, roleKey, trace),
    action: "role.delete",
  },
  {
    endpoint: "roles.revoke",
    input: (roleKey: string) => ({ roleKey, permissionKey: "admin.roles", scopeId: 0 }),
    prepare: (roleKey: string) => prepareApiRoleRevoke(actor, roleKey, "admin.roles", 0, trace),
    action: "grant.revoke",
  },
  {
    endpoint: "users.role-revoke",
    input: (roleKey: string) => ({ roleKey, scopeId: 0, reason }),
    prepare: (roleKey: string, uid: number) =>
      prepareApiUserRoleRevoke(actor, uid, roleKey, 0, reason, trace),
    action: "user_role.revoke",
  },
] as const;

function roleWriteRequest(
  method: "POST" | "PUT",
  path: string,
  issued: CreatedAdminApiToken,
  key: string,
  input: unknown,
) {
  const init = {
    method,
    headers: {
      authorization: `Bearer ${issued.plain}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: input instanceof ReadableStream ? input : JSON.stringify(input),
    duplex: "half" as const,
  };
  return new NextRequest(`http://localhost/api/manage/${path}`, init);
}

/** 等实际路由通过外层门禁并读取请求体，期间提交另一事务，再让原请求继续。 */
async function changeWhileReadingBody<T>(
  send: (body: ReadableStream<Uint8Array>) => Promise<Response>,
  input: unknown,
  change: () => Promise<T>,
) {
  const reading = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reading.resolve();
        await resume.promise;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const response = send(stream);
  let baseline: T;
  try {
    await Promise.race([
      reading.promise,
      response.then((res) => {
        throw new Error(`请求未进入读体阶段：HTTP ${res.status}`);
      }),
    ]);
    baseline = await change();
  } finally {
    resume.resolve();
    await response;
  }
  return { response: await response, baseline };
}

let tempDb: TempDb;
describe.skipIf(skipDb)("管理 REST 角色授权 · 真实 MySQL", () => {
  beforeAll(async () => {
    tempDb = await setupTempDb();
  });
  afterAll(async () => {
    await tempDb?.teardown();
  });
  beforeEach(async ({ onTestFinished }) => {
    resetRateLimiter();
    vi.stubEnv("MANAGE_API_WRITES", "on");
    credential = await issueRoleToken(actor.userId);
    const { id, suffix } = credential;
    trace = { requestId, tokenSuffix: suffix };
    onTestFinished(async () => {
      await db().delete(adminApiTokens).where(eq(adminApiTokens.id, id));
    });
  });
  afterEach(() => {
    invalidateAuthzSnapshot();
    vi.unstubAllEnvs();
  });

  it("使用锁内角色状态裁决，并持有实际角色行排他锁", async () => {
    const ctx = await makeContext();
    const roleKey = "rest-role-lock";
    await createCustomRole(actor, roleKey, "锁测试", "");
    const operation = await prepareApiRoleGrant(actor, roleKey, "admin.roles", 0, trace);
    if (!operation.ok) throw new Error("准备阶段意外拒绝");
    await setRolePublic(actor, roleKey, true);
    const before = await sideEffects();
    const key = randomUUID();

    await expect(
      commitRoleWrite(
        ctx,
        "roles.grant",
        { roleKey, permissionKey: "admin.roles", scopeId: 0 },
        Promise.resolve<Awaited<Parameters<typeof commitManageRoleWrite>[3]>>({
          ok: true,
          async lock(tx) {
            const lock = await operation.lock(tx);
            if (lock.ok) await expectRoleRowLocked(roleKey);
            return lock;
          },
        }),
        key,
      ),
    ).rejects.toMatchObject({ code: "state_conflict" });
    expect((await roleRows(roleKey)).grants).toEqual([]);
    expect(await sideEffects()).toEqual(before);
    expect(await idempotencyRows(ctx.token, key)).toEqual([]);
  });

  it("绑定在锁内复验角色存在性，期间被删除的角色不会留下孤儿绑定", async () => {
    const ctx = await makeContext();
    const roleKey = "rest-role-removed";
    const uid = DEMO.member;
    await createCustomRole(actor, roleKey, "随后删除", "");
    const prepared = prepareApiUserRoleAssign(actor, uid, roleKey, 0, null, reason, trace);
    expect(await prepared).toMatchObject({ ok: true });
    await deleteCustomRole(actor, roleKey);
    const before = await sideEffects();
    const key = randomUUID();
    await expect(
      commitRoleWrite(
        ctx,
        "users.role-assign",
        { roleKey, scopeId: 0, reason },
        prepared,
        key,
        uid,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await roleRows(roleKey)).toEqual({ roles: [], grants: [], bindings: [] });
    expect(await sideEffects()).toEqual(before);
    expect(await idempotencyRows(ctx.token, key)).toEqual([]);
  });

  it("拒绝隐式角色提权、固定团队角色变更和内置管理员授权撤销", async () => {
    const ctx = await makeContext();
    await createCustomRole(actor, teamRole, "固定团队身份", "");
    const before = await sideEffects();
    await expect(prepareApiRoleGrant(actor, "member", "forum.moderate", 0)).resolves.toMatchObject({
      ok: false,
      code: "implicit_guard",
    });
    await expect(prepareApiRoleRevoke(actor, "admin", "site.admin", 0)).resolves.toMatchObject({
      ok: false,
      code: "admin_locked",
    });
    await expect(
      prepareApiUserRoleAssign(actor, DEMO.member, teamRole, 0, null, reason),
    ).resolves.toMatchObject({ ok: false, code: "team_role" });
    await expect(
      prepareApiUserRoleRevoke(actor, DEMO.member, teamRole, 0, reason),
    ).resolves.toMatchObject({ ok: false, code: "team_role" });
    for (const roleKey of [teamRole, "admin"]) {
      await expect(
        commitRoleWrite(ctx, "roles.delete", { roleKey }, prepareApiRoleDelete(actor, roleKey)),
      ).rejects.toMatchObject({ code: "state_conflict" });
    }
    expect(await sideEffects()).toEqual(before);
  });

  it("后台和 REST 不写入非规范角色键，规范角色仍可授予和绑定", async () => {
    const uid = String(DEMO.member);
    const permission = "admin.roles";
    const grant = (roleKey: string, key = randomUUID()) =>
      putRoleGrant(
        roleWriteRequest("PUT", `roles/${roleKey}/grants/${permission}`, credential, key, {
          scopeId: 0,
        }),
        { params: Promise.resolve({ roleKey, permission }) },
      );
    const assign = (roleKey: string, key = randomUUID()) =>
      putUserRole(
        roleWriteRequest("PUT", `users/${uid}/roles/${roleKey}`, credential, key, {
          scopeId: 0,
          reason,
        }),
        { params: Promise.resolve({ uid, roleKey }) },
      );

    const legacy = "RéSt-Legacy-Key";
    const alias = "rest-legacy-key";
    await db().insert(roles).values({ key: legacy, name: "旧角色", kind: "custom" });
    const before = await sideEffects();
    await expect(grantRolePermission(actor, legacy, permission, 0)).rejects.toThrow(/角色不存在/);
    await expect(assignUserRole(actor, DEMO.member, legacy, 0, null, reason)).rejects.toThrow(
      /角色不存在/,
    );
    for (const send of [grant, assign]) {
      const key = randomUUID();
      const response = await send(alias, key);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
      expect(await idempotencyRows(credential, key)).toEqual([]);
    }
    expect(await roleRows(legacy)).toMatchObject({
      roles: [{ key: legacy }],
      grants: [],
      bindings: [],
    });
    // HTTP 入口仍留访问审计，不应留下业务审计或角色事件。
    const after = await sideEffects();
    expect(after.audit.slice(before.audit.length)).toMatchObject([
      { action: "api.roles.grant", targetType: "manage_api" },
      { action: "api.users.role-assign", targetType: "manage_api" },
    ]);
    expect(after.outbox).toEqual(before.outbox);

    const roleKey = "rest-canonical-key";
    await createCustomRole(actor, roleKey, "规范角色", "");
    // 兼容后台调用的等价输入，但写入必须复用锁定的规范键。
    await grantRolePermission(actor, roleKey.toUpperCase(), "site.admin", 0);
    await assignUserRole(actor, DEMO.xiaoyi, roleKey.toUpperCase(), 0, null, reason);
    expect((await grant(roleKey)).status).toBe(200);
    expect((await assign(roleKey)).status).toBe(200);
    expect(await roleRows(roleKey)).toMatchObject({
      grants: expect.arrayContaining([
        { id: expect.any(Number), roleKey, permissionKey: "site.admin", scopeId: 0 },
        { id: expect.any(Number), roleKey, permissionKey: permission, scopeId: 0 },
      ]),
      bindings: expect.arrayContaining([
        expect.objectContaining({ userId: DEMO.xiaoyi, roleKey }),
        expect.objectContaining({ userId: DEMO.member, roleKey }),
      ]),
    });
    await deleteCustomRole(actor, roleKey);
  });

  it("同键授权只写一次并回放首次结果，异参冲突，新键重复授权不写审计", async () => {
    const ctx = await makeContext();
    const roleKey = "rest-role-grant";
    const input = { roleKey, permissionKey: "forum.read", scopeId: 0 };
    await createCustomRole(actor, roleKey, "可授权", "");
    const snapshot = await getAuthzSnapshot();
    const key = randomUUID();
    const grant = (idempotencyKey: string, scopeId = 0) =>
      commitRoleWrite(
        ctx,
        "roles.grant",
        { ...input, scopeId },
        prepareApiRoleGrant(actor, roleKey, input.permissionKey, scopeId, trace),
        idempotencyKey,
      );
    const initial = { ...input, changed: true };
    await expect(Promise.all([grant(key), grant(key)])).resolves.toEqual([initial, initial]);
    expect(await getAuthzSnapshot()).not.toBe(snapshot);
    await expect(grant(key, DEMO.restrictedForum)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await expect(grant(randomUUID())).resolves.toEqual({ ...input, changed: false });
    expect(await idempotencyRows(ctx.token, key)).toMatchObject([{ response: initial }]);
    expect(
      await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "grant.add"), eq(auditLog.targetId, roleKey))),
    ).toMatchObject([
      { afterJson: { permissionKey: "forum.read", scopeId: 0, via: "api", ...trace } },
    ]);
  });

  it("并发不同键创建同名角色，只提交一次，失败的幂等占位回滚", async () => {
    const ctx = await makeContext();
    const input = { key: "rest-role-duplicate", name: "角色", description: "" };
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(
      keys.map((key) =>
        commitRoleWrite(ctx, "roles.create", input, prepareApiRoleCreate(actor, input, trace), key),
      ),
    );
    expect(results).toContainEqual({
      status: "fulfilled",
      value: { key: input.key, name: input.name },
    });
    const rejected = results.findIndex(({ status }) => status === "rejected");
    expect(rejected).toBeGreaterThanOrEqual(0);
    expect(results[rejected]).toMatchObject({ reason: { code: "state_conflict" } });
    expect(await idempotencyRows(ctx.token, keys[rejected])).toEqual([]);
  });

  it("绑定重放不依赖当前有效期或角色行，且只入队并派发一次", async () => {
    const ctx = await makeContext();
    const uid = await makeActiveUser("role-replay-user");
    const roleKey = "rest-role-replay";
    const expiry = Date.now() + 600_000;
    const expiresAt = nowBeijingWallTime(expiry);
    const input = { roleKey, scopeId: 0, expiresAt, reason };
    const key = randomUUID();
    const assign = () =>
      commitRoleWrite(
        ctx,
        "users.role-assign",
        input,
        prepareApiUserRoleAssign(actor, uid, roleKey, 0, expiresAt, reason, trace),
        key,
        uid,
      );
    await createCustomRole(actor, roleKey, "绑定回放", "");
    const expected = { userId: uid, roleKey, scopeId: 0 };
    await expect(assign()).resolves.toEqual(expected);
    await deleteCustomRole(actor, roleKey);
    const beforeReplay = await sideEffects();
    const now = vi.spyOn(Date, "now").mockReturnValue(expiry + 10_000);
    try {
      await expect(assign()).resolves.toEqual(expected);
    } finally {
      now.mockRestore();
    }
    expect(await sideEffects()).toEqual(beforeReplay);
    const events = beforeReplay.outbox.filter(
      (event) => (event.payload as { roleKey?: string } | null)?.roleKey === roleKey,
    );
    expect(events).toHaveLength(1);
    expect(events[0].dispatchedAt).toBeTruthy();
  });

  it("在途撤销 admin.users 后，即使资格与令牌仍有效、旧快照仍在缓存也不能回放", async ({
    onTestFinished,
  }) => {
    const uid = await makeActiveUser("role-inflight-holder");
    const holderRole = "role-inflight-holder";
    const targetRole = "role-inflight-target";
    onTestFinished(async () => {
      // 本例只撤端点权限，不撤管理员资格；不能把永久管理员留下给后面的末位测试。
      await db().delete(userRoles).where(eq(userRoles.userId, uid));
      await db().delete(adminApiTokens).where(eq(adminApiTokens.userId, uid));
    });
    await seedAdminRole(holderRole, uid);
    await createCustomRole(actor, targetRole, "在途绑定测试目标", "");
    const issued = await issueRoleToken(uid);
    const key = randomUUID();
    const targetUid = String(DEMO.member);
    const input = { scopeId: 0, reason };
    const send = (body: unknown) =>
      putUserRole(
        roleWriteRequest("PUT", `users/${targetUid}/roles/${targetRole}`, issued, key, body),
        { params: Promise.resolve({ uid: targetUid, roleKey: targetRole }) },
      );
    const initial = await send(input);
    expect(initial.status).toBe(200);
    const previous = await idempotencyRows(issued, key);
    expect(previous).toHaveLength(1);
    const targetBefore = await roleRows(targetRole);
    const snapshot = await getAuthzSnapshot();

    const { response, baseline } = await changeWhileReadingBody(send, input, async () => {
      // 模拟另一进程提交授权变更：数据库已撤权，但本进程缓存尚未失效。
      await db().transaction(async (tx) => {
        await lockSiteAdminInvariant(tx);
        await tx
          .delete(roleGrants)
          .where(
            and(
              eq(roleGrants.roleKey, holderRole),
              eq(roleGrants.permissionKey, "admin.users"),
              eq(roleGrants.scopeId, 0),
            ),
          );
      });
      expect(await getAuthzSnapshot()).toBe(snapshot);
      return sideEffects();
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(await idempotencyRows(issued, key)).toEqual(previous);
    expect(await roleRows(targetRole)).toEqual(targetBefore);
    expect(await sideEffects()).toEqual(baseline);
    expect(
      await db().select().from(adminApiTokens).where(eq(adminApiTokens.id, issued.id)),
    ).toMatchObject([{ revokedAt: null }]);
  });

  it("在途手动吊销后返回 401，不裁决同键异参冲突", async () => {
    const issued = credential;
    const key = randomUUID();
    const input = { key: "role-revocation-original", name: "原始角色", description: "" };
    const attempted = { ...input, key: "role-revocation-conflict" };
    const send = (body: unknown) => postRole(roleWriteRequest("POST", "roles", issued, key, body));
    const initial = await send(input);
    expect(initial.status).toBe(200);
    const previous = await idempotencyRows(issued, key);
    expect(previous).toHaveLength(1);
    const { response, baseline } = await changeWhileReadingBody(send, attempted, async () => {
      expect(
        await revokeAdminApiToken({
          tokenId: issued.id,
          userId: actor.userId,
          actor: { userId: actor.userId, via: "admin" },
        }),
      ).toBe(true);
      return sideEffects();
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(await idempotencyRows(issued, key)).toEqual(previous);
    expect(await roleRows(attempted.key)).toEqual({ roles: [], grants: [], bindings: [] });
    expect(await sideEffects()).toEqual(baseline);
  });

  it.each([
    { label: "令牌已过期", change: { expiresAt: "2000-01-01 00:00:00" }, code: "unauthorized" },
    {
      label: "令牌快照非法",
      change: { permissionSnapshot: ["roles.create", "roles.create"] },
      code: "unauthorized",
    },
    {
      label: "令牌快照缺少写端点",
      change: { permissionSnapshot: ["roles"] },
      code: "forbidden",
    },
  ])("$label 时不新建角色或幂等记录", async ({ change, code }) => {
    const issued = credential;
    const ctx = await makeContext();
    await db().update(adminApiTokens).set(change).where(eq(adminApiTokens.id, issued.id));
    const key = randomUUID();
    const input = { key: "role-invalid-credential", name: "不可创建", description: "" };
    const before = await sideEffects();
    await expect(
      createManageRole(ctx, { input, idempotencyKey: key, targetId: 0 }),
    ).rejects.toMatchObject({ code });
    expect(await idempotencyRows(issued, key)).toEqual([]);
    expect(await roleRows(input.key)).toEqual({ roles: [], grants: [], bindings: [] });
    expect(await sideEffects()).toEqual(before);
  });

  it.for(revocations)(
    "$endpoint 拒绝移除末位管理员时整体回滚，恢复后同键可成功",
    async (variant, { onTestFinished }) => {
      const ctx = await makeContext();
      const adminUid = DEMO.admin;
      const roleKey = `rest-${variant.endpoint.replaceAll(".", "-")}`;
      onTestFinished(async () => {
        await db()
          .delete(userRoles)
          .where(and(eq(userRoles.userId, adminUid), eq(userRoles.roleKey, roleKey)));
      });
      await seedAdminRole(roleKey, adminUid);
      const victim = await insertLegacyToken(adminUid, roleKey);
      onTestFinished(async () => {
        await db().delete(adminApiTokens).where(eq(adminApiTokens.id, victim.id));
      });
      const tokenRow = () =>
        db().select().from(adminApiTokens).where(eq(adminApiTokens.id, victim.id));
      const key = randomUUID();
      const execute = () =>
        commitRoleWrite(
          ctx,
          variant.endpoint,
          variant.input(roleKey),
          variant.prepare(roleKey, adminUid),
          key,
          adminUid,
        );
      const adminBinding = and(eq(userRoles.userId, adminUid), eq(userRoles.roleKey, "admin"));
      await db().delete(userRoles).where(adminBinding);

      try {
        expect(await db().transaction((tx) => isLastPermanentSiteAdmin(tx, adminUid))).toBe(true);
        const current = await roleRows(roleKey);
        const before = await sideEffects();
        await expect(execute()).rejects.toMatchObject({ code: "state_conflict" });
        expect(await roleRows(roleKey)).toEqual(current);
        expect(await tokenRow()).toHaveLength(1);
        expect(await sideEffects()).toEqual(before);
        expect(await idempotencyRows(ctx.token, key)).toEqual([]);
      } finally {
        await db()
          .insert(userRoles)
          .values({ userId: adminUid, roleKey: "admin", scopeId: 0, grantedAt: sql`NOW()` });
      }

      const success = await execute();
      const afterSuccess = await sideEffects();
      await expect(execute()).resolves.toEqual(success);
      expect(await sideEffects()).toEqual(afterSuccess);
      expect(await idempotencyRows(ctx.token, key)).toMatchObject([{ response: success }]);
      expect(await tokenRow()).toHaveLength(1);
      expect(
        afterSuccess.audit.filter((row) => row.action === variant.action).at(-1),
      ).toMatchObject({ afterJson: { ...trace, via: "api" } });
    },
  );

  it.each(revocations)("$endpoint 实际降权后，同事务吊销当事人的令牌", async (variant) => {
    const ctx = await makeContext();
    const uid = await makeActiveUser(`cascade-${variant.endpoint.replaceAll(".", "-")}`);
    const roleKey = `cascade-${variant.endpoint.replaceAll(".", "-")}`;
    await seedAdminRole(roleKey, uid);
    const token = await insertLegacyToken(uid);
    const key = randomUUID();
    const success = await commitRoleWrite(
      ctx,
      variant.endpoint,
      variant.input(roleKey),
      variant.prepare(roleKey, uid),
      key,
      uid,
    );
    expect(await db().select().from(adminApiTokens).where(eq(adminApiTokens.id, token.id))).toEqual(
      [],
    );
    expect(await idempotencyRows(ctx.token, key)).toMatchObject([{ response: success }]);
    expect(
      await db()
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, "api_token.cascade_revoke"), eq(auditLog.targetId, String(uid))),
        ),
    ).toMatchObject([{ afterJson: { count: 1, triggerVia: "api", ...trace } }]);
  });

  it("出站事件写入失败时回滚已执行的解绑、吊销、审计和幂等占位", async () => {
    const ctx = await makeContext();
    const uid = await makeActiveUser("role-outbox-rollback");
    const roleKey = "role-outbox-rollback";
    await seedAdminRole(roleKey, uid);
    const token = await insertLegacyToken(uid);
    const previous = await roleRows(roleKey);
    const before = await sideEffects();
    const key = randomUUID();
    const execute = () =>
      commitRoleWrite(
        ctx,
        "users.role-revoke",
        { roleKey, reason },
        prepareApiUserRoleRevoke(actor, uid, roleKey, 0, reason, trace),
        key,
        uid,
      );
    await db().execute(sql`CREATE TRIGGER reject_role_outbox BEFORE INSERT ON event_outbox
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '测试拒绝事件写入'`);
    try {
      await expect(execute()).rejects.toMatchObject({ cause: { code: "ER_SIGNAL_EXCEPTION" } });
      expect(await roleRows(roleKey)).toEqual(previous);
      expect(
        await db().select().from(adminApiTokens).where(eq(adminApiTokens.id, token.id)),
      ).toHaveLength(1);
      expect(await sideEffects()).toEqual(before);
      expect(await idempotencyRows(ctx.token, key)).toEqual([]);
    } finally {
      await db().execute(sql`DROP TRIGGER reject_role_outbox`);
    }
    await expect(execute()).resolves.toMatchObject({ changed: true });
  });
});
