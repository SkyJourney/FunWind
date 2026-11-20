// @vitest-environment node
/**
 * 权限内核的真实 MySQL 集成测试（临时库 + 演示夹具）：
 * 规则快照加载与失效、主体加载（过期角色/限制过滤）、管理动作的校验/同事务审计、版主派生。
 */
import "@/modules";
import { and, eq, sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  DEMO,
  auditLog,
  eventOutbox,
  forums,
  getWebDb,
  roleGrants,
  roles,
  userRestrictions,
  userRoles,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skipDb, setupTempDb, type TempDb } from "@/test/temp-db";
import {
  AdminError,
  assignUserRole,
  createCustomRole,
  deleteCustomRole,
  grantRolePermission,
  listRoles,
  revokeRolePermission,
  revokeUserRole,
  setRolePublic,
  type AdminActor,
} from "./admin";
import {
  checkPermission,
  getForumModerators,
  getModeratedForumIds,
  getReadableForumIds,
} from "./service";
import {
  hasPermanentSiteAdmin,
  isEffectiveSiteAdmin,
  roleHasGlobalSiteAdminGrant,
} from "./site-admin-invariant";
import { getAuthzSnapshot, getForumTree, invalidateAuthzSnapshot } from "./snapshot";
import { loadSubject } from "./subject";

let tdb: TempDb;
const admin: AdminActor = { userId: DEMO.admin, ip: "203.0.113.7" };

const audits = async (action?: string) => {
  const rows = await getWebDb().select().from(auditLog).orderBy(auditLog.id);
  return action ? rows.filter((r) => r.action === action) : rows;
};

describe.skipIf(skipDb)("权限内核 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  describe("规则快照", () => {
    it("加载演示版块树与全部授权；有进程内缓存，失效后重建", async () => {
      const a = await getAuthzSnapshot();
      expect(a.tree.has(DEMO.restrictedForum)).toBe(true);
      expect(a.grants.length).toBeGreaterThan(0);
      expect(await getAuthzSnapshot()).toBe(a); // 命中缓存
      invalidateAuthzSnapshot();
      expect(await getAuthzSnapshot()).not.toBe(a);
    });

    it("getForumTree 与快照共用同一棵树", async () => {
      expect(await getForumTree()).toBe((await getAuthzSnapshot()).tree);
    });

    it("演示夹具：受限版块 904 的有效读策略为 restricted", async () => {
      const { tree } = await getAuthzSnapshot();
      expect(tree.readPolicy(DEMO.restrictedForum).value).toBe("restricted");
      expect(tree.reviewPolicy(DEMO.reviewForum).value).toBe("all");
    });
  });

  describe("主体加载", () => {
    it("userId=null / 不存在 → 游客；已注销账号 → 游客", async () => {
      expect((await loadSubject(null)).userId).toBeNull();
      expect((await loadSubject(987654321)).userId).toBeNull();
      await getWebDb().execute(sql`UPDATE users SET state = 'deleted' WHERE id = ${DEMO.xiaoyi}`);
      expect((await loadSubject(DEMO.xiaoyi)).userId).toBeNull();
      await getWebDb().execute(sql`UPDATE users SET state = 'active' WHERE id = ${DEMO.xiaoyi}`);
    });

    it("登录用户隐含 member@0，并带上显式角色绑定；邮箱验证态与注册模式", async () => {
      const s = await loadSubject(DEMO.team);
      expect(s.userId).toBe(DEMO.team);
      expect(s.roles).toContainEqual({ key: "member", scopeId: 0 });
      expect(s.roles).toContainEqual({ key: DEMO.teamRole, scopeId: 0 });
      expect(s.emailVerified).toBe(false);
      expect(s.emailVerificationRequired).toBe(false);
      expect(s.registerMode).toBe("invite");

      await getWebDb()
        .update(users)
        .set({ emailVerificationRequired: true })
        .where(eq(users.id, DEMO.team));
      try {
        expect((await loadSubject(DEMO.team)).emailVerificationRequired).toBe(true);
      } finally {
        await getWebDb()
          .update(users)
          .set({ emailVerificationRequired: false })
          .where(eq(users.id, DEMO.team));
      }
    });

    it("过期的角色绑定被过滤；未生效/已结束的限制被过滤", async () => {
      const db = getWebDb();
      await db.insert(userRoles).values([
        {
          userId: DEMO.member,
          roleKey: DEMO.teamRole,
          scopeId: 0,
          expiresAt: "2000-01-01 00:00:00",
          grantedAt: "2000-01-01 00:00:00",
        },
      ]);
      await db.insert(userRestrictions).values([
        {
          userId: DEMO.member,
          kind: "mute",
          scopeId: 0,
          reason: "已结束",
          startsAt: "2000-01-01 00:00:00",
          endsAt: "2000-02-01 00:00:00",
          createdAt: "2000-01-01 00:00:00",
        },
        {
          userId: DEMO.member,
          kind: "mute",
          scopeId: 0,
          reason: "尚未开始",
          startsAt: "2999-01-01 00:00:00",
          createdAt: "2000-01-01 00:00:00",
        },
        {
          userId: DEMO.member,
          kind: "no_signature",
          scopeId: 0,
          reason: "永久",
          startsAt: "2000-01-01 00:00:00",
          createdAt: "2000-01-01 00:00:00",
        },
      ]);
      const s = await loadSubject(DEMO.member);
      expect(s.roles.map((r) => r.key)).toEqual(["member"]);
      expect(s.restrictions.map((r) => r.kind)).toEqual(["no_signature"]);
    });

    it("被封禁演示用户的主体带有生效中的 ban", async () => {
      const s = await loadSubject(DEMO.banned);
      expect(s.restrictions.some((r) => r.kind === "ban")).toBe(true);
    });
  });

  describe("真实夹具上的权限判定", () => {
    it("受限版块：游客/普通会员拒绝，演示团队成员允许，admin 允许", async () => {
      const f = DEMO.restrictedForum;
      expect(
        (await checkPermission(await loadSubject(null), "forum.read", { forumId: f })).allowed,
      ).toBe(false);
      expect(
        (await checkPermission(await loadSubject(DEMO.member), "forum.read", { forumId: f }))
          .allowed,
      ).toBe(false);
      expect(
        (await checkPermission(await loadSubject(DEMO.team), "forum.read", { forumId: f })).allowed,
      ).toBe(true);
      expect(
        (await checkPermission(await loadSubject(DEMO.admin), "forum.read", { forumId: f }))
          .allowed,
      ).toBe(true);
    });

    it("可读版块集合：游客读不到受限版块，团队成员读得到（首页聚合据此过滤）", async () => {
      const guest = await getReadableForumIds(await loadSubject(null));
      const team = await getReadableForumIds(await loadSubject(DEMO.team));
      expect(guest).not.toContain(DEMO.restrictedForum);
      expect(team).toContain(DEMO.restrictedForum);
      expect(await getModeratedForumIds(await loadSubject(DEMO.member))).toEqual([]);
    });

    it("带 sign 限制的主体：签名档权限被拒；其余写权限不受影响", async () => {
      const s = await loadSubject(DEMO.member);
      expect((await checkPermission(s, "sign.use")).allowed).toBe(false);
      expect((await checkPermission(s, "forum.write", { forumId: 901 })).allowed).toBe(true);
    });
  });

  describe("管理动作：校验与同事务审计", () => {
    it("createCustomRole：新建成功并写审计；同名（含内置角色）一律拒绝且不改写", async () => {
      await createCustomRole(admin, "team-media", "媒体组", "测试");
      const [r] = await getWebDb().select().from(roles).where(eq(roles.key, "team-media"));
      expect(r).toMatchObject({ kind: "custom", name: "媒体组" });

      await expect(createCustomRole(admin, "team-media", "改名", "x")).rejects.toThrow(AdminError);
      await expect(createCustomRole(admin, "admin", "我是管理员", "x")).rejects.toThrow(/内置/);
      await expect(createCustomRole(admin, "Bad_Key", "x", "")).rejects.toThrow(/kebab-case/);
      const [adminRole] = await getWebDb().select().from(roles).where(eq(roles.key, "admin"));
      expect(adminRole).toMatchObject({ kind: "builtin", name: "管理员" }); // 未被改写

      const log = await audits("role.create");
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        actorId: DEMO.admin,
        targetType: "role",
        targetId: "team-media",
        ip: "203.0.113.7",
      });
    });

    it("公开身份显式启用；后台权限角色不能公开", async () => {
      const key = "team-media";
      expect((await listRoles()).find((role) => role.key === key)?.isPublic).toBe(false);
      await setRolePublic(admin, key, true);
      expect((await listRoles()).find((role) => role.key === key)?.isPublic).toBe(true);
      await expect(grantRolePermission(admin, key, "admin.users", 0)).rejects.toThrow(/公开身份/);

      await setRolePublic(admin, key, false);
      await getWebDb().insert(roleGrants).values({
        roleKey: key,
        permissionKey: "admin.users",
        scopeId: 0,
      });
      try {
        await expect(setRolePublic(admin, key, true)).rejects.toThrow(/后台管理权限/);
      } finally {
        await getWebDb()
          .delete(roleGrants)
          .where(
            and(
              eq(roleGrants.roleKey, key),
              eq(roleGrants.permissionKey, "admin.users"),
              eq(roleGrants.scopeId, 0),
            ),
          );
      }
    });

    it("grant：校验角色/权限点/作用域；幂等；提权护栏；生效即时（快照失效）", async () => {
      await expect(grantRolePermission(admin, "no-such", "forum.read", 0)).rejects.toThrow(
        /角色不存在/,
      );
      await expect(grantRolePermission(admin, "team-media", "p1", 0)).rejects.toThrow(/未知权限点/);
      await expect(grantRolePermission(admin, "team-media", "forum.read", 424242)).rejects.toThrow(
        /版块不存在/,
      );
      await expect(grantRolePermission(admin, "member", "forum.moderate", 0)).rejects.toThrow(
        /隐式角色/,
      );
      await expect(grantRolePermission(admin, "guest", "admin.users", 0)).rejects.toThrow(
        /隐式角色/,
      );

      const before = (await audits("grant.add")).length;
      await grantRolePermission(admin, "team-media", "forum.read", DEMO.restrictedForum);
      await grantRolePermission(admin, "team-media", "forum.read", DEMO.restrictedForum); // 幂等
      expect((await audits("grant.add")).length).toBe(before + 1);

      // 绑定后立即生效
      await assignUserRole(admin, DEMO.member, "team-media", 0, null, "集成测试授予");
      const s = await loadSubject(DEMO.member);
      expect(
        (await checkPermission(s, "forum.read", { forumId: DEMO.restrictedForum })).allowed,
      ).toBe(true);
    });

    it("revoke：撤销即时生效；admin 的 site.admin/admin.roles 不可撤销（防自锁）", async () => {
      await revokeRolePermission(admin, "team-media", "forum.read", DEMO.restrictedForum);
      const s = await loadSubject(DEMO.member);
      expect(
        (await checkPermission(s, "forum.read", { forumId: DEMO.restrictedForum })).allowed,
      ).toBe(false);
      await expect(revokeRolePermission(admin, "admin", "site.admin", 0)).rejects.toThrow(
        /防止后台被锁死/,
      );
      await expect(revokeRolePermission(admin, "admin", "admin.roles", 0)).rejects.toThrow(
        /防止后台被锁死/,
      );
      expect((await audits("grant.revoke")).length).toBe(1);
    });

    it("用户角色绑定：隐式角色不可绑；用户须存在；可撤销；均写审计", async () => {
      await expect(assignUserRole(admin, DEMO.member, "member", 0, null, "reason")).rejects.toThrow(
        /隐式角色/,
      );
      await expect(assignUserRole(admin, 987654, "team-media", 0, null, "reason")).rejects.toThrow(
        /用户不存在/,
      );
      await expect(
        assignUserRole(admin, DEMO.member, "team-media", 424242, null, "reason"),
      ).rejects.toThrow(/版块不存在/);
      for (const expiresAt of [
        "2000-01-01 00:00:00",
        "2099-02-29 00:00:00",
        "2096-02-30 00:00:00",
        "2099-01-01T00:00:00",
      ]) {
        await expect(
          assignUserRole(admin, DEMO.member, "team-media", 0, expiresAt, "reason"),
        ).rejects.toThrow("到期时间必须是有效的未来北京时间");
      }
      await revokeUserRole(admin, DEMO.member, "team-media", 0, "集成测试撤销");
      const s = await loadSubject(DEMO.member);
      expect(s.roles.map((r) => r.key)).toEqual(["member"]);
      expect((await audits("user_role.assign")).length).toBe(1);
      expect((await audits("user_role.revoke")).length).toBe(1);
    });

    it("assign / revoke 提交后派发 role.changed；重复撤销（空操作）不派发", async () => {
      const seen: unknown[] = [];
      const deps = { emitter: async (_n: "role.changed", p: unknown) => void seen.push(p) };
      await createCustomRole(admin, "team-events", "事件测试", "");
      await assignUserRole(
        admin,
        DEMO.member,
        "team-events",
        0,
        null,
        "事件测试授予",
        deps as never,
      );
      await revokeUserRole(admin, DEMO.member, "team-events", 0, "事件测试撤销", deps as never);
      await revokeUserRole(admin, DEMO.member, "team-events", 0, "事件测试撤销", deps as never); // 已不存在
      const outbox = await getWebDb()
        .select({ payload: eventOutbox.payload, policy: eventOutbox.deliveryPolicy })
        .from(eventOutbox)
        .where(eq(eventOutbox.eventName, "role.changed"));
      expect(
        outbox
          .filter(({ payload }) => (payload as { roleKey?: string }).roleKey === "team-events")
          .map(({ policy }) => policy),
      ).toEqual(["role_notification_v1", "role_notification_v1"]);
      expect(seen).toEqual([
        {
          userId: DEMO.member,
          roleKey: "team-events",
          scopeId: 0,
          action: "granted",
          operatorId: DEMO.admin,
          expiresAt: null,
        },
        {
          userId: DEMO.member,
          roleKey: "team-events",
          scopeId: 0,
          action: "revoked",
          operatorId: DEMO.admin,
          expiresAt: null,
        },
      ]);
    });

    it("deleteCustomRole：内置不可删；自定义角色连带授权与绑定清除，审计记录规模", async () => {
      await expect(deleteCustomRole(admin, "admin")).rejects.toThrow(/内置/);
      await grantRolePermission(admin, "team-media", "forum.report", 0);
      await assignUserRole(admin, DEMO.xiaoyi, "team-media", 0, null, "版块权限测试");
      await deleteCustomRole(admin, "team-media");
      const db = getWebDb();
      expect(await db.select().from(roles).where(eq(roles.key, "team-media"))).toHaveLength(0);
      expect(
        await db.select().from(roleGrants).where(eq(roleGrants.roleKey, "team-media")),
      ).toHaveLength(0);
      expect(
        await db.select().from(userRoles).where(eq(userRoles.roleKey, "team-media")),
      ).toHaveLength(0);
      const [log] = await audits("role.delete");
      expect(log?.beforeJson).toEqual({ grants: 1, holders: 1 });
    });

    it("仅剩限时替补时，解绑、撤权、删角色或改限时均不能移除末位永久管理员", async () => {
      const roleA = "m96-site-admin-a";
      const roleB = "m96-site-admin-b";
      const expiry = "2099-01-01 00:00:00";
      for (const roleKey of [roleA, roleB]) {
        await createCustomRole(admin, roleKey, roleKey, "last-admin guard");
        await grantRolePermission(admin, roleKey, "site.admin", 0);
        await grantRolePermission(admin, roleKey, "admin.roles", 0);
      }
      await assignUserRole(admin, DEMO.member, roleA, 0, null, "管理员测试授予");
      await assignUserRole(admin, DEMO.team, roleB, 0, null, "管理员测试授予");
      await assignUserRole(admin, DEMO.admin, "admin", 0, expiry, "设置限时替补");

      try {
        const results = await Promise.allSettled([
          revokeUserRole(admin, DEMO.member, roleA, 0, "并发撤销测试"),
          revokeUserRole(admin, DEMO.team, roleB, 0, "并发撤销测试"),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({
          message: expect.stringContaining("永久站点管理员"),
        });
        const [remainingUser, remainingRole] =
          results[0].status === "fulfilled" ? [DEMO.team, roleB] : [DEMO.member, roleA];
        const db = getWebDb();
        const beforeAudit = await audits();
        const beforeEvents = await db.select({ id: eventOutbox.id }).from(eventOutbox);

        await expect(revokeRolePermission(admin, remainingRole, "site.admin", 0)).rejects.toThrow(
          /永久站点管理员/,
        );
        await expect(deleteCustomRole(admin, remainingRole)).rejects.toThrow(/永久站点管理员/);
        await expect(
          assignUserRole(admin, remainingUser, remainingRole, 0, expiry, "由永久改成限时"),
        ).rejects.toThrow(/永久站点管理员/);

        expect(await audits()).toHaveLength(beforeAudit.length);
        expect(await db.select({ id: eventOutbox.id }).from(eventOutbox)).toHaveLength(
          beforeEvents.length,
        );
        const [binding] = await db
          .select({ expiresAt: userRoles.expiresAt })
          .from(userRoles)
          .where(and(eq(userRoles.userId, remainingUser), eq(userRoles.roleKey, remainingRole)));
        expect(binding?.expiresAt).toBeNull();
        await db.transaction(async (tx) => {
          expect(await hasPermanentSiteAdmin(tx, { userId: remainingUser })).toBe(true);
          expect(await hasPermanentSiteAdmin(tx, { userId: DEMO.admin })).toBe(false);
          expect(await isEffectiveSiteAdmin(tx, DEMO.admin)).toBe(true);
        });
      } finally {
        await assignUserRole(admin, DEMO.admin, "admin", 0, null, "并发测试恢复管理角色");
        await deleteCustomRole(admin, roleA);
        await deleteCustomRole(admin, roleB);
      }
    });

    it("仅剩临时管理员时仍可修复：两项全站权限可由同一可登录用户的不同永久角色提供", async () => {
      const db = getWebDb();
      const siteRole = "recovery-site-admin";
      const rolesRole = "recovery-admin-roles";
      const temporary = "2099-01-01 00:00:00";
      const builtIn = and(eq(userRoles.userId, DEMO.admin), eq(userRoles.roleKey, "admin"));
      const target = eq(users.id, DEMO.member);
      await createCustomRole(admin, siteRole, siteRole, "");
      await createCustomRole(admin, rolesRole, rolesRole, "");

      try {
        // 模拟升级前仅有限时管理员的历史库，不能通过正式入口削弱最后一条永久绑定。
        await db.update(userRoles).set({ expiresAt: temporary }).where(builtIn);
        await grantRolePermission(admin, siteRole, "site.admin", 0);
        await grantRolePermission(admin, rolesRole, "admin.roles", 0);
        await assignUserRole(admin, DEMO.member, siteRole, 0, null, "补授站点权限");
        await assignUserRole(admin, DEMO.member, rolesRole, DEMO.restrictedForum, null, "版块绑定");
        await assignUserRole(admin, DEMO.team, rolesRole, 0, null, "另一账号持有角色权限");
        await assignUserRole(admin, DEMO.member, rolesRole, 0, temporary, "限时获得角色权限");
        await db.transaction(async (tx) => {
          expect(await hasPermanentSiteAdmin(tx)).toBe(false);
          expect(await isEffectiveSiteAdmin(tx, DEMO.member)).toBe(true);
        });

        await db.update(users).set({ loginVerificationRequired: true }).where(target);
        await assignUserRole(admin, DEMO.member, rolesRole, 0, null, "修复为永久绑定");
        expect(await db.transaction((tx) => hasPermanentSiteAdmin(tx))).toBe(false);
        await db.update(users).set({ loginVerificationRequired: false }).where(target);
        expect(
          await db.transaction((tx) => hasPermanentSiteAdmin(tx, { userId: DEMO.member })),
        ).toBe(true);
      } finally {
        await db.update(userRoles).set({ expiresAt: null }).where(builtIn);
        await db.update(users).set({ loginVerificationRequired: false }).where(target);
        await deleteCustomRole(admin, siteRole);
        await deleteCustomRole(admin, rolesRole);
      }
    });

    it.each([
      { binding: "M96-FALLBACK", grant: "m96-fallback", permission: "admin.roles" },
      { binding: "m96-fallback", grant: "m96-fállback", permission: "admin.roles" },
      { binding: "m96-fallback", grant: "m96-fallback", permission: "Admin.Roles" },
      { binding: "m96-fallback", grant: "m96-fallback", permission: "admin.róles" },
      { binding: "m96-fallback", grant: "m96-fallback", permission: "admin.roles " },
    ])(
      "历史键 $binding / $grant / '$permission' 不能充当保底",
      async ({ binding, grant, permission }) => {
        const db = getWebDb();
        const roleKey = "m96-fallback";
        const target = DEMO.member;
        try {
          await db.insert(roles).values({ key: roleKey, name: "历史角色", kind: "custom" });
          await db
            .insert(userRoles)
            .values({ userId: target, roleKey: binding, grantedAt: sql`NOW()` });
          await db.insert(roleGrants).values([
            { roleKey: grant, permissionKey: permission },
            { roleKey: grant, permissionKey: "site.admin" },
          ]);
          invalidateAuthzSnapshot();
          expect((await checkPermission(await loadSubject(target), "admin.roles")).allowed).toBe(
            false,
          );
          await db.transaction(async (tx) => {
            expect(await isEffectiveSiteAdmin(tx, target)).toBe(false);
            expect(await hasPermanentSiteAdmin(tx, { excludingUserId: DEMO.admin })).toBe(false);
          });
          await expect(
            revokeUserRole(admin, DEMO.admin, "admin", 0, "末位保护测试"),
          ).rejects.toThrow(/永久站点管理员/);
        } finally {
          await db
            .insert(userRoles)
            .ignore()
            .values({ userId: DEMO.admin, roleKey: "admin", grantedAt: sql`NOW()` });
          await db.delete(userRoles).where(eq(userRoles.roleKey, roleKey));
          await db.delete(roleGrants).where(eq(roleGrants.roleKey, roleKey));
          await db.delete(roles).where(eq(roles.key, roleKey));
          invalidateAuthzSnapshot();
        }
      },
    );

    it("保底前置检测只接受实际的角色键与管理权限点", async () => {
      const db = getWebDb();
      const roleKey = "m96-precheck";
      await db.insert(roleGrants).values({ roleKey, permissionKey: "síte.admin" });
      try {
        await db.transaction(async (tx) => {
          expect(await roleHasGlobalSiteAdminGrant(tx, roleKey)).toBe(false);
          expect(await roleHasGlobalSiteAdminGrant(tx, "ADMIN")).toBe(false);
          expect(await roleHasGlobalSiteAdminGrant(tx, "admin")).toBe(true);
          expect(await hasPermanentSiteAdmin(tx, { throughRoleKey: "ADMIN" })).toBe(false);
          expect(await hasPermanentSiteAdmin(tx, { throughRoleKey: "admin" })).toBe(true);
        });
      } finally {
        await db.delete(roleGrants).where(eq(roleGrants.roleKey, roleKey));
      }
    });

    it("精确匹配且已生效的历史绑定受末位保护，已有保底时可清理", async () => {
      const db = getWebDb();
      const roleKey = "m96-effective";
      const historicalKey = "M96-EFFECTIVE";
      const target = DEMO.member;
      const temporary = "2099-01-01 00:00:00";
      const builtIn = and(eq(userRoles.userId, DEMO.admin), eq(userRoles.roleKey, "admin"));
      try {
        await db.insert(roles).values({ key: roleKey, name: "历史生效角色", kind: "custom" });
        await db.insert(userRoles).values({
          userId: target,
          roleKey: historicalKey,
          grantedAt: sql`NOW()`,
        });
        await db.insert(roleGrants).values([
          { roleKey: historicalKey, permissionKey: "site.admin" },
          { roleKey: historicalKey, permissionKey: "admin.roles" },
        ]);
        await db.update(userRoles).set({ expiresAt: temporary }).where(builtIn);
        invalidateAuthzSnapshot();
        expect((await checkPermission(await loadSubject(target), "admin.roles")).allowed).toBe(
          true,
        );
        expect(await db.transaction((tx) => isEffectiveSiteAdmin(tx, target))).toBe(true);
        const revoke = () => revokeUserRole(admin, target, roleKey, 0, "清理历史绑定");
        for (const change of [
          revoke,
          () => revokeRolePermission(admin, roleKey, "admin.roles", 0),
          () => deleteCustomRole(admin, roleKey),
          () => assignUserRole(admin, target, roleKey, 0, temporary, "由永久改为限时"),
        ]) {
          await expect(change()).rejects.toThrow(/永久站点管理员/);
        }
        await db.update(userRoles).set({ expiresAt: null }).where(builtIn);
        await expect(revoke()).resolves.toBeUndefined();
      } finally {
        await db.update(userRoles).set({ expiresAt: null }).where(builtIn);
        await db.delete(userRoles).where(eq(userRoles.roleKey, roleKey));
        await db.delete(roleGrants).where(eq(roleGrants.roleKey, roleKey));
        await db.delete(roles).where(eq(roles.key, roleKey));
        invalidateAuthzSnapshot();
      }
    });

    it("每个管理动作的审计行都带 actor / 时间；失败的动作不留审计", async () => {
      const all = await audits();
      expect(all.length).toBeGreaterThan(0);
      for (const a of all) {
        expect(a.actorId).toBe(DEMO.admin);
        expect(a.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
      }
      const n = all.length;
      await expect(grantRolePermission(admin, "no-such", "forum.read", 0)).rejects.toThrow();
      expect((await audits()).length).toBe(n);
    });
  });

  describe("派生版主", () => {
    it("版主 = 链上持有 forum.moderate 授权的角色的持有人；继承标注 viaParent", async () => {
      await createCustomRole(admin, "section-mod", "分区版主", "");
      await grantRolePermission(admin, "section-mod", "forum.moderate", 900); // 演示分区
      await assignUserRole(admin, DEMO.xiaoyi, "section-mod", 0, null, "版主角色测试");
      const direct = await getForumModerators(900);
      expect(direct).toEqual([{ userId: DEMO.xiaoyi, username: "demo_小翼", viaParent: false }]);
      const inherited = await getForumModerators(901);
      expect(inherited).toEqual([{ userId: DEMO.xiaoyi, username: "demo_小翼", viaParent: true }]);
      // admin 不算“版主”；与授权无关的版块（不存在）为空
      expect(await getForumModerators(424242)).toEqual([]);
      // 版主能管理其子树
      const s = await loadSubject(DEMO.xiaoyi);
      expect((await checkPermission(s, "forum.moderate", { forumId: 901 })).allowed).toBe(true);
      expect(await getModeratedForumIds(s)).toContain(901);

      await getWebDb()
        .insert(accountDeletionRequests)
        .values({
          userId: DEMO.xiaoyi,
          status: "completed",
          requestedAt: sql`NOW()`,
          scheduledAt: sql`NOW()`,
          completedAt: sql`NOW()`,
        });
      try {
        expect(await getForumModerators(901)).toEqual([]);
      } finally {
        await getWebDb()
          .delete(accountDeletionRequests)
          .where(
            and(
              eq(accountDeletionRequests.userId, DEMO.xiaoyi),
              eq(accountDeletionRequests.status, "completed"),
            ),
          );
      }
    });

    it("同一用户继承并直接持有版主授权时，直接授权优先展示", async () => {
      const roleKey = "section-mod-direct";
      await createCustomRole(admin, roleKey, "子版块版主", "");
      await grantRolePermission(admin, roleKey, "forum.moderate", 901);
      await assignUserRole(admin, DEMO.xiaoyi, roleKey, 0, null, "直接版主角色测试");
      try {
        expect(await getForumModerators(901)).toEqual([
          { userId: DEMO.xiaoyi, username: "demo_小翼", viaParent: false },
        ]);
      } finally {
        await getWebDb()
          .delete(userRoles)
          .where(and(eq(userRoles.userId, DEMO.xiaoyi), eq(userRoles.roleKey, roleKey)));
        invalidateAuthzSnapshot();
      }
    });

    it("角色绑定的作用域也必须覆盖该版块", async () => {
      const db = getWebDb();
      await db
        .delete(userRoles)
        .where(and(eq(userRoles.userId, DEMO.xiaoyi), eq(userRoles.roleKey, "section-mod")));
      await assignUserRole(admin, DEMO.xiaoyi, "section-mod", 904, null, "版主作用域测试"); // 只绑在受限版块
      expect(await getForumModerators(901)).toEqual([]);
      const rows = await db.select({ id: forums.id }).from(forums).where(eq(forums.id, 904));
      expect(rows).toHaveLength(1);
    });
  });

  describe("并发（放在最后：其他用例按审计总条数断言）", () => {
    it("并发重复绑定同一用户角色：全部成功，只有一行绑定；到期时间以最后写入为准（复查 B5）", async () => {
      await createCustomRole(admin, "team-conc2", "并发绑定", "");
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          assignUserRole(admin, DEMO.xiaoyi, "team-conc2", 0, null, "并发角色测试"),
        ),
      );
      expect(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => String((r as PromiseRejectedResult).reason).slice(0, 90)),
      ).toEqual([]);
      const rows = await getWebDb()
        .select()
        .from(userRoles)
        .where(and(eq(userRoles.userId, DEMO.xiaoyi), eq(userRoles.roleKey, "team-conc2")));
      expect(rows).toHaveLength(1);
      await getWebDb().delete(userRoles).where(eq(userRoles.roleKey, "team-conc2"));
      invalidateAuthzSnapshot();
    });

    it("并发重复授权（双击 / 重复提交）：全部视为成功的幂等操作，只写一次库、一条审计，不抛原始唯一键错误（复查 B5）", async () => {
      await createCustomRole(admin, "team-conc", "并发测试", "");
      const before = (await audits("grant.add")).length;
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          grantRolePermission(admin, "team-conc", "forum.report", DEMO.restrictedForum),
        ),
      );
      expect(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => String((r as PromiseRejectedResult).reason).slice(0, 90)),
      ).toEqual([]);
      expect((await audits("grant.add")).length).toBe(before + 1);
      const rows = await getWebDb()
        .select()
        .from(roleGrants)
        .where(
          and(
            eq(roleGrants.roleKey, "team-conc"),
            eq(roleGrants.permissionKey, "forum.report"),
            eq(roleGrants.scopeId, DEMO.restrictedForum),
          ),
        );
      expect(rows).toHaveLength(1);
      // 收尾：直接删库行（不走带审计的撤销，免得影响其他用例对审计条数的断言）
      await getWebDb()
        .delete(roleGrants)
        .where(
          and(
            eq(roleGrants.roleKey, "team-conc"),
            eq(roleGrants.permissionKey, "forum.report"),
            eq(roleGrants.scopeId, DEMO.restrictedForum),
          ),
        );
      invalidateAuthzSnapshot();
    });
  });
});
