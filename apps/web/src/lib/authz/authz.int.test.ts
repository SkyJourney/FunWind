// @vitest-environment node
/**
 * 权限内核的真实 MySQL 集成测试（临时库 + 演示夹具）：
 * 规则快照加载与失效、主体加载（过期角色/限制过滤）、管理动作的校验/同事务审计、版主派生。
 */
import { and, eq, sql } from "drizzle-orm";
import {
  DEMO,
  auditLog,
  forums,
  getWebDb,
  roleGrants,
  roles,
  userRestrictions,
  userRoles,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skipDb, setupTempDb, type TempDb } from "@/test/temp-db";
import {
  AdminError,
  assignUserRole,
  createCustomRole,
  deleteCustomRole,
  grantRolePermission,
  revokeRolePermission,
  revokeUserRole,
  type AdminActor,
} from "./admin";
import {
  checkPermission,
  getForumModerators,
  getModeratedForumIds,
  getReadableForumIds,
  requirePermission,
} from "./service";
import { getAuthzSnapshot, invalidateAuthzSnapshot } from "./snapshot";
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
      expect(s.registerMode).toBe("invite");
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

    it("requirePermission 拒绝时抛 ForbiddenError", async () => {
      await expect(
        requirePermission(await loadSubject(DEMO.member), "admin.roles"),
      ).rejects.toThrow(/权限不足/);
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
      await assignUserRole(admin, DEMO.member, "team-media", 0);
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
      await expect(assignUserRole(admin, DEMO.member, "member", 0)).rejects.toThrow(/隐式角色/);
      await expect(assignUserRole(admin, 987654, "team-media", 0)).rejects.toThrow(/用户不存在/);
      await expect(assignUserRole(admin, DEMO.member, "team-media", 424242)).rejects.toThrow(
        /版块不存在/,
      );
      await revokeUserRole(admin, DEMO.member, "team-media", 0);
      const s = await loadSubject(DEMO.member);
      expect(s.roles.map((r) => r.key)).toEqual(["member"]);
      expect((await audits("user_role.assign")).length).toBe(1);
      expect((await audits("user_role.revoke")).length).toBe(1);
    });

    it("assign / revoke 提交后派发 role.changed；重复撤销（空操作）不派发", async () => {
      const seen: unknown[] = [];
      const deps = { emitter: async (_n: "role.changed", p: unknown) => void seen.push(p) };
      await createCustomRole(admin, "team-events", "事件测试", "");
      await assignUserRole(admin, DEMO.member, "team-events", 0, null, deps as never);
      await revokeUserRole(admin, DEMO.member, "team-events", 0, deps as never);
      await revokeUserRole(admin, DEMO.member, "team-events", 0, deps as never); // 已不存在
      expect(seen).toEqual([
        {
          userId: DEMO.member,
          roleKey: "team-events",
          scopeId: 0,
          action: "granted",
          operatorId: DEMO.admin,
        },
        {
          userId: DEMO.member,
          roleKey: "team-events",
          scopeId: 0,
          action: "revoked",
          operatorId: DEMO.admin,
        },
      ]);
    });

    it("deleteCustomRole：内置不可删；自定义角色连带授权与绑定清除，审计记录规模", async () => {
      await expect(deleteCustomRole(admin, "admin")).rejects.toThrow(/内置/);
      await grantRolePermission(admin, "team-media", "forum.report", 0);
      await assignUserRole(admin, DEMO.xiaoyi, "team-media", 0);
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
      await assignUserRole(admin, DEMO.xiaoyi, "section-mod", 0);
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
    });

    it("角色绑定的作用域也必须覆盖该版块", async () => {
      const db = getWebDb();
      await db
        .delete(userRoles)
        .where(and(eq(userRoles.userId, DEMO.xiaoyi), eq(userRoles.roleKey, "section-mod")));
      await assignUserRole(admin, DEMO.xiaoyi, "section-mod", 904); // 只绑在受限版块
      expect(await getForumModerators(901)).toEqual([]);
      const rows = await db.select({ id: forums.id }).from(forums).where(eq(forums.id, 904));
      expect(rows).toHaveLength(1);
    });
  });
});
