// @vitest-environment node
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApiTokens, auditLog, getWebDb } from "@funwind/db";
import { NextRequest } from "next/server";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { createRestriction } from "@/lib/authz/restrictions-admin";
import { manageEndpoint, manageOk } from "./route";
import { requestAccountDeletionWithPassword } from "@/lib/auth/account-deletion";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { ManageApiError } from "./errors";
import { TOKEN_RATE_PER_MIN, authenticateManageRequest } from "./guard";
import { createAdminApiToken, revokeAdminApiToken } from "./tokens";
import { makeActiveUser, makeSiteAdmin } from "./int-fixtures";

/**
 * Bearer 门禁全链路（真实临时库）：无头/格式错/查无/过期/吊销/持有人注销一律 401
 * （存在性不泄露），普通用户持 token 资格不足 403，per-token 桶 429。
 * NextRequest 只用到 headers——duck type 一个带 Headers 的对象即可。
 */
describe.skipIf(skipDb)("apiAdminGuard 鉴权链（M20 · 真实临时库）", () => {
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    const db: TempDb = await setupTempDb();
    teardown = db.teardown;
  });
  afterAll(() => teardown());

  beforeEach(() => {
    resetRateLimiter();
  });

  const requestOf = (authorization?: string): NextRequest =>
    ({
      headers: authorization ? new Headers({ authorization }) : new Headers(),
    }) as unknown as NextRequest;

  async function issueFor(uid: number, name = "t"): Promise<string> {
    const created = await createAdminApiToken({
      userId: uid,
      name,
      days: 90,
      actor: { userId: uid, via: "admin" },
    });
    return created.plain;
  }

  it("无头 / 格式错 / 查无此 token → 一律 401", async () => {
    await expect(authenticateManageRequest(requestOf())).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(authenticateManageRequest(requestOf("Bearer fw_at_short"))).rejects.toMatchObject({
      code: "unauthorized",
    });
    const forged = `fw_at_${"z".repeat(43)}`;
    await expect(authenticateManageRequest(requestOf(`Bearer ${forged}`))).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("有效管理员 token 放行，身份与尾号正确返回", async () => {
    const uid = await makeSiteAdmin("g_ok");
    const plain = await issueFor(uid, "握手");
    const identity = await authenticateManageRequest(requestOf(`Bearer ${plain}`));
    expect(identity.token.userId).toBe(uid);
    expect(identity.token.name).toBe("握手");
    expect(identity.subject.userId).toBe(uid);
  });

  it("过期 / 手动吊销 → 401", async () => {
    const uid = await makeSiteAdmin("g_expired");
    const created = await createAdminApiToken({
      userId: uid,
      name: "t",
      days: 90,
      actor: { userId: uid, via: "admin" },
    });
    await getWebDb()
      .update(adminApiTokens)
      .set({ expiresAt: sql`NOW() - INTERVAL 1 SECOND` })
      .where(eq(adminApiTokens.id, created.id));
    await expect(
      authenticateManageRequest(requestOf(`Bearer ${created.plain}`)),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });

    const uid2 = await makeSiteAdmin("g_revoked");
    const created2 = await createAdminApiToken({
      userId: uid2,
      name: "t",
      days: 90,
      actor: { userId: uid2, via: "admin" },
    });
    await revokeAdminApiToken({
      tokenId: created2.id,
      userId: uid2,
      actor: { userId: uid2, via: "admin" },
    });
    await expect(
      authenticateManageRequest(requestOf(`Bearer ${created2.plain}`)),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("持有人进入注销（closure_pending）→ loadSubject GUEST → 401", async () => {
    const uid = await makeSiteAdmin("g_closing");
    const plain = await issueFor(uid);
    await requestAccountDeletionWithPassword({ userId: uid }, "test-pass");
    await expect(authenticateManageRequest(requestOf(`Bearer ${plain}`))).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("普通用户持 token：凭证真实但资格不足 → 403", async () => {
    const uid = await makeActiveUser("g_plain");
    const plain = await issueFor(uid);
    await expect(authenticateManageRequest(requestOf(`Bearer ${plain}`))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("被封禁的管理员重签 token：凭证真实但资格被 evaluator 拒绝 → 403（第二道防线）", async () => {
    const uid = await makeSiteAdmin("g_banned_admin");
    const ban = await createRestriction(
      { userId: 90004, via: "admin", ip: null },
      { userId: uid, kind: "ban", scopeId: 0, reason: "int 封禁管理员", endsAt: null },
    );
    expect(ban.ok).toBe(true);
    // 联动吊销已把原 token 物理删（第一道防线）；此处模拟「封禁后异常残留/重签」的凭证
    const plain = await issueFor(uid, "residual");
    await expect(authenticateManageRequest(requestOf(`Bearer ${plain}`))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("manageEndpoint 的调用审计落库：via=api、query 摘要、token 尾号（除 whoami 外）", async () => {
    const uid = await makeSiteAdmin("g_audit");
    const plain = await issueFor(uid, "审计探针");
    const endpoint = manageEndpoint(async () => manageOk({ probed: true }), {
      endpoint: "audit-probe",
      permission: "admin.logs",
    });
    const request = new NextRequest(
      "http://127.0.0.1:3000/api/manage/audit-probe?sample=1&token_should_not_leak=irrelevant",
    );
    request.headers.set("authorization", `Bearer ${plain}`);
    const response = await endpoint(request);
    expect(response.status).toBe(200);

    const [row] = await getWebDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "api.audit-probe"))
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.targetType).toBe("manage_api");
    expect(row?.targetId).toBe("/api/manage/audit-probe");
    const after = row?.afterJson as { query: string; tokenSuffix: string; via: string };
    expect(after.via).toBe("api");
    expect(after.query).toContain('"sample"');
    expect(after.tokenSuffix).toBe(plain.slice(-8));
    // query 摘要照实记录（管理 API 的调用方持有合法凭证，审计面仅管理员可见）
    expect(row?.actorId).toBe(uid);
  });

  it("per-token 桶：同一 token 超过每分钟配额 → 429", async () => {
    const uid = await makeSiteAdmin("g_ratelimit");
    const plain = await issueFor(uid);
    let hit: ManageApiError | null = null;
    for (let i = 0; i < TOKEN_RATE_PER_MIN + 1; i++) {
      try {
        await authenticateManageRequest(requestOf(`Bearer ${plain}`));
      } catch (error) {
        if (error instanceof ManageApiError && error.code === "rate_limited") {
          hit = error;
          break;
        }
        throw error;
      }
    }
    expect(hit).not.toBeNull();
    expect(hit?.retryAfterSec).toBeGreaterThan(0);
  });
});
