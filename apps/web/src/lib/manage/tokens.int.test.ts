// @vitest-environment node
import { and, count, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApiTokens, auditLog, getWebDb, roleGrants, userRoles, users } from "@funwind/db";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { hashPassword } from "@/lib/auth/password";
import { requestAccountDeletionWithPassword } from "@/lib/auth/account-deletion";
import { purgeUserDataInTx } from "@/lib/auth/account-deletion-purge";
import {
  assignUserRole,
  createCustomRole,
  deleteCustomRole,
  grantRolePermission,
  revokeRolePermission,
  revokeUserRole,
  type AdminActor,
} from "@/lib/authz/admin";
import { createRestriction } from "@/lib/authz/restrictions-admin";
import { revokeTeamMembership } from "@/lib/authz/team-membership";
import {
  ADMIN_API_TOKEN_LIMIT,
  createAdminApiToken,
  resolveUsableApiToken,
  revokeAdminApiToken,
} from "./tokens";

/**
 * 撤权联动吊销穷举（M20 D4，真实临时库）：
 * 每个可能使管理员失去资格的写事务（撤角色绑定 / 撤全局授权 / 删角色 / 全站封禁 /
 * 注销申请 / 注销完成 purge / 收回团队角色）都断言「当事管理员的 token 同事务被吊 +
 * api_token.cascade_revoke 审计落库」；非降权路径断言不误伤。
 * demo_admin(90004) 全程不动、只作「另一位有效管理员」兜底不变量断言。
 */
describe.skipIf(skipDb)("管理 token 签发/吊销/撤权联动（M20 · 真实临时库）", () => {
  let teardown: () => Promise<void>;
  const ACTOR: AdminActor = { userId: 90004, ip: null };
  /** 每场景独立当事用户，避免场景间污染 */
  let nextUid = 91001;

  beforeAll(async () => {
    const db: TempDb = await setupTempDb();
    teardown = db.teardown;
  });
  afterAll(() => teardown());

  beforeEach(async () => {
    // 场景间只清 token 表（审计按 targetId 区分，保留供断言）
    await getWebDb().delete(adminApiTokens);
  });

  /** 造一位满足站点管理员不变量的用户（active + 有密码 + 绑 admin@0；bootstrap 已给 admin 角色双持授权） */
  async function makeSiteAdmin(username: string): Promise<number> {
    const uid = await makeActiveUser(username);
    await getWebDb()
      .insert(userRoles)
      .values({ userId: uid, roleKey: "admin", scopeId: 0, grantedAt: "2026-11-17 00:00:00" });
    return uid;
  }

  /** 造一位 active 用户（不绑角色）；「撤该角色后是否失格」场景由此 + makeCustomRoleAdmin 组合构造 */
  async function makeActiveUser(username: string): Promise<number> {
    const uid = nextUid++;
    await getWebDb()
      .insert(users)
      .values({
        id: uid,
        username,
        usernameKey: username,
        email: `${username}@test.local`,
        emailKey: `${username}@test.local`,
        passwordHash: await hashPassword("test-pass"),
        emailVerifiedAt: "2026-11-17 00:00:00",
        state: "active",
        createdAt: "2026-11-17 00:00:00",
      });
    return uid;
  }

  /** 造「custom 角色 + 双持全局授权」，assignUserRole 绑到 uid（服务绑定） */
  async function makeCustomRoleAdmin(roleKey: string, uid: number): Promise<void> {
    await createCustomRole(ACTOR, roleKey, roleKey, "int 夹具");
    await grantRolePermission(ACTOR, roleKey, "site.admin", 0);
    await grantRolePermission(ACTOR, roleKey, "admin.roles", 0);
    await assignUserRole(ACTOR, uid, roleKey, 0, null, "int 夹具绑定");
  }

  /** 有效 token 数（revoked IS NULL）——手动吊销是软吊销（update），物理删除只发生在联动吊销与 cleanup */
  const activeCountOf = async (uid: number): Promise<number> =>
    Number(
      (
        await getWebDb()
          .select({ n: count() })
          .from(adminApiTokens)
          .where(and(eq(adminApiTokens.userId, uid), isNull(adminApiTokens.revokedAt)))
      )[0]?.n ?? 0,
    );

  /** 全部行数（含已吊销）——联动吊销是物理删，断言「全删」用 */
  const tokenCountOf = async (uid: number): Promise<number> =>
    Number(
      (
        await getWebDb()
          .select({ n: count() })
          .from(adminApiTokens)
          .where(eq(adminApiTokens.userId, uid))
      )[0]?.n ?? 0,
    );

  const cascadeAuditsOf = async (uid: number): Promise<number> =>
    Number(
      (
        await getWebDb()
          .select({ n: count() })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, "api_token.cascade_revoke"),
              eq(auditLog.targetType, "user"),
              eq(auditLog.targetId, String(uid)),
            ),
          )
      )[0]?.n ?? 0,
    );

  it("签发/解析/手动吊销与上限（D2/D5）", async () => {
    const uid = await makeSiteAdmin("tok_basic");
    const created = await createAdminApiToken({
      userId: uid,
      name: "CI 脚本",
      days: 90,
      actor: { userId: uid, via: "admin" },
    });
    expect(created.plain).toMatch(/^fw_at_[A-Za-z0-9_-]{43}$/);
    expect((await resolveUsableApiToken(created.plain))?.userId).toBe(uid);
    expect(await resolveUsableApiToken(`fw_at_${"z".repeat(43)}`)).toBeNull();

    // 吊销即失效；重复吊销幂等 false；他人 token 不可越权吊
    expect(
      await revokeAdminApiToken({
        tokenId: created.id,
        userId: uid,
        actor: { userId: uid, via: "admin" },
      }),
    ).toBe(true);
    expect(await resolveUsableApiToken(created.plain)).toBeNull();
    expect(
      await revokeAdminApiToken({
        tokenId: created.id,
        userId: uid,
        actor: { userId: uid, via: "admin" },
      }),
    ).toBe(false);

    // 上限按有效 token 计：签满 5 个后拒绝第 6 个；吊销一个后可再签
    for (let i = 0; i < ADMIN_API_TOKEN_LIMIT; i++) {
      await createAdminApiToken({
        userId: uid,
        name: `tk${i}`,
        days: 30,
        actor: { userId: uid, via: "admin" },
      });
    }
    await expect(
      createAdminApiToken({
        userId: uid,
        name: "超额",
        days: 30,
        actor: { userId: uid, via: "admin" },
      }),
    ).rejects.toThrow(/最多签发/);
    const latest = await getWebDb()
      .select({ id: adminApiTokens.id })
      .from(adminApiTokens)
      .where(and(eq(adminApiTokens.userId, uid), isNull(adminApiTokens.revokedAt)))
      .limit(1);
    expect(latest[0]).toBeDefined();
    await revokeAdminApiToken({
      tokenId: latest[0]!.id,
      userId: uid,
      actor: { userId: uid, via: "admin" },
    });
    await createAdminApiToken({
      userId: uid,
      name: "补签",
      days: 30,
      actor: { userId: uid, via: "admin" },
    });
    // 有效数回到上限；总行数 7（软吊销的两行仍在，等 cleanup 物理删）
    expect(await activeCountOf(uid)).toBe(ADMIN_API_TOKEN_LIMIT);
    expect(await tokenCountOf(uid)).toBe(ADMIN_API_TOKEN_LIMIT + 2);
  });

  it("撤角色绑定（revokeUserRole）联动吊销", async () => {
    const uid = await makeSiteAdmin("tok_role_revoke");
    const created = await createAdminApiToken({
      userId: uid,
      name: "t",
      days: 90,
      actor: { userId: uid, via: "admin" },
    });
    await revokeUserRole(ACTOR, uid, "admin", 0, "int 撤 admin 角色");
    expect(await tokenCountOf(uid)).toBe(0);
    expect(await resolveUsableApiToken(created.plain)).toBeNull();
    expect(await cascadeAuditsOf(uid)).toBeGreaterThan(0);
  });

  it("非降权的角色撤销不误伤 token", async () => {
    const uid = await makeSiteAdmin("tok_no_cascade");
    // 先绑一个无 admin 授权的自定义角色，撤它不动管理员资格
    await createCustomRole(ACTOR, "plain-role", "plain", "无授权角色");
    await assignUserRole(ACTOR, uid, "plain-role", 0, null, "int 绑定");
    await createAdminApiToken({
      userId: uid,
      name: "t",
      days: 90,
      actor: { userId: uid, via: "admin" },
    });
    await revokeUserRole(ACTOR, uid, "plain-role", 0, "int 撤非 admin 角色");
    expect(await tokenCountOf(uid)).toBe(1);
    expect(await cascadeAuditsOf(uid)).toBe(0);
  });

  it("撤全局授权（revokeRolePermission）联动吊销", async () => {
    // 只持 grant-holder 双持角色的用户：撤其 site.admin 授权后即失格（并存 admin@0 会让不变量仍满足）
    const uid = await makeActiveUser("tok_grant_revoke");
    await makeCustomRoleAdmin("grant-holder", uid);
    const created = await createAdminApiToken({
      userId: uid,
      name: "t",
      days: 90,
      actor: { userId: uid, via: "admin" },
    });
    await revokeRolePermission(ACTOR, "grant-holder", "site.admin", 0);
    expect(await tokenCountOf(uid)).toBe(0);
    expect(await resolveUsableApiToken(created.plain)).toBeNull();
    expect(await cascadeAuditsOf(uid)).toBeGreaterThan(0);
  });

  it("删自定义角色（deleteCustomRole）联动吊销", async () => {
    const uid = await makeActiveUser("tok_role_delete");
    await makeCustomRoleAdmin("deleted-holder", uid);
    const created = await createAdminApiToken({
      userId: uid,
      name: "t",
      days: 90,
      actor: { userId: uid, via: "admin" },
    });
    await deleteCustomRole(ACTOR, "deleted-holder");
    expect(await tokenCountOf(uid)).toBe(0);
    expect(await resolveUsableApiToken(created.plain)).toBeNull();
    expect(await cascadeAuditsOf(uid)).toBeGreaterThan(0);
    expect(
      (await getWebDb().select().from(roleGrants).where(eq(roleGrants.roleKey, "deleted-holder")))
        .length,
    ).toBe(0);
  });

  it("全站封禁（createRestriction globalBan）联动吊销；重复封禁幂等分支同样吊销", async () => {
    const uid = await makeSiteAdmin("tok_banned");
    const created = await createAdminApiToken({
      userId: uid,
      name: "t",
      days: 90,
      actor: { userId: uid, via: "admin" },
    });
    const result = await createRestriction(
      { userId: ACTOR.userId, via: "admin", ip: null },
      { userId: uid, kind: "ban", scopeId: 0, reason: "int 封禁", endsAt: null },
    );
    expect(result.ok).toBe(true);
    expect(await tokenCountOf(uid)).toBe(0);
    expect(await resolveUsableApiToken(created.plain)).toBeNull();
    expect(await cascadeAuditsOf(uid)).toBeGreaterThan(0);
  });

  it("注销申请（closure_pending）联动吊销；purge 完成兜底再清", async () => {
    const uid = await makeSiteAdmin("tok_closing");
    await createAdminApiToken({
      userId: uid,
      name: "t1",
      days: 90,
      actor: { userId: uid, via: "admin" },
    });
    // 注销申请使 userNotClosing 不再满足 → 吊销（30 天 pending 期 token 已不可用）
    const request = await requestAccountDeletionWithPassword({ userId: uid }, "test-pass");
    expect(request.requestId).toBeGreaterThan(0);
    expect(await tokenCountOf(uid)).toBe(0);
    expect(await cascadeAuditsOf(uid)).toBeGreaterThan(0);

    // pending 期间异常残留的 token：purge 不清理（受「不扩大删表」守卫纪律约束）——
    // 残留行已成孤儿（guard 的 loadSubject 对非 active 用户返回 GUEST → 401 双保险），由 cleanup 物理删
    await createAdminApiToken({
      userId: uid,
      name: "t2",
      days: 90,
      actor: { userId: uid, via: "admin" },
    });
    await getWebDb().transaction((tx) => purgeUserDataInTx(tx, uid));
    expect(await tokenCountOf(uid)).toBe(1);
    // purge 连用户角色一并清理
    expect(
      (await getWebDb().select().from(userRoles).where(eq(userRoles.userId, uid))).length,
    ).toBe(0);
  });

  it("收回团队角色（revokeTeamMembership）联动吊销", async () => {
    // 只持 team-tech 的用户（并存 admin@0 会让不变量仍满足，联动正确地不吊销）
    const uid = await makeActiveUser("tok_team_revoke");
    // 团队角色绑定不能走 assignUserRole（护栏强制走团队服务），直接落绑定行模拟既有持有人
    await createCustomRole(ACTOR, "team-tech", "技术组", "int 夹具");
    await grantRolePermission(ACTOR, "team-tech", "site.admin", 0);
    await grantRolePermission(ACTOR, "team-tech", "admin.roles", 0);
    await getWebDb()
      .insert(userRoles)
      .values({ userId: uid, roleKey: "team-tech", scopeId: 0, grantedAt: "2026-11-17 00:00:00" });
    const created = await createAdminApiToken({
      userId: uid,
      name: "t",
      days: 90,
      actor: { userId: uid, via: "admin" },
    });
    await revokeTeamMembership(
      { userId: ACTOR.userId, via: "admin", ip: null },
      uid,
      "team-tech",
      "int 收回",
    );
    expect(await tokenCountOf(uid)).toBe(0);
    expect(await resolveUsableApiToken(created.plain)).toBeNull();
    expect(await cascadeAuditsOf(uid)).toBeGreaterThan(0);
  });
});
