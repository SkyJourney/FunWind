import { describe, expect, it } from "vitest";
import {
  BUILTIN_ROLE_KEYS,
  DEFAULT_ROLE_GRANTS,
  DEFAULT_LIMITS,
  DEFAULT_SITE_SETTINGS,
  PERMISSION_DEFINITIONS,
  READ_POLICIES,
  REVIEW_POLICIES,
  WRITE_POLICIES,
  ROLE_DEFINITIONS,
  isKnownPermission,
  levelSatisfies,
  permissionSatisfies,
} from "./authz-vocab.js";

describe("权限词汇表", () => {
  it("权限点键唯一，且为 resource.action 形态", () => {
    const keys = PERMISSION_DEFINITIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of PERMISSION_DEFINITIONS) {
      expect(p.key).toMatch(/^[a-z]+\.[A-Za-z]+$/);
      expect(p.key.startsWith(`${p.resource}.`)).toBe(true);
    }
  });

  it("共 25 个权限点；已取消功能的权限点不再出现", () => {
    expect(PERMISSION_DEFINITIONS).toHaveLength(25);
    for (const dead of [
      "forum.manage",
      "thread.sell",
      "thread.hide",
      "thread.award",
      "thread.remoteImage",
      "media.embed",
      "invite.buy",
      "remind.receive",
      "forum.viewLog",
      "forum.forceReason",
      "design.manage",
      "fresh.delete",
    ]) {
      expect(isKnownPermission(dead), dead).toBe(false);
    }
  });

  it("提权护栏：词汇表本身不带任何自动映射信息，forum.moderate 是唯一的版主权限点", () => {
    for (const p of PERMISSION_DEFINITIONS) {
      expect(Object.keys(p).sort(), p.key).toEqual(["description", "key", "level", "resource"]);
    }
    expect(PERMISSION_DEFINITIONS.filter((p) => p.level === "manage").map((p) => p.key)).toEqual([
      "forum.moderate",
    ]);
  });

  it("分级域仅 forum：read < write < manage，且只有一个版主权限点", () => {
    const leveled = PERMISSION_DEFINITIONS.filter((p) => p.level !== null);
    expect(leveled.map((p) => p.key).sort()).toEqual([
      "forum.moderate",
      "forum.read",
      "forum.write",
    ]);
    expect(levelSatisfies("read", "manage")).toBe(true);
    expect(levelSatisfies("write", "read")).toBe(false);
    expect(levelSatisfies("manage", "write")).toBe(false);
  });

  it("每个权限点都能被自身满足（词汇表全覆盖）", () => {
    for (const p of PERMISSION_DEFINITIONS) {
      expect(permissionSatisfies(p.key, p.key), p.key).toBe(true);
    }
  });

  it("级别隐含：moderate ⊃ write ⊃ read；动作型与跨资源不隐含", () => {
    expect(permissionSatisfies("forum.moderate", "forum.write")).toBe(true);
    expect(permissionSatisfies("forum.moderate", "forum.read")).toBe(true);
    expect(permissionSatisfies("forum.write", "forum.read")).toBe(true);
    expect(permissionSatisfies("forum.read", "forum.write")).toBe(false);
    expect(permissionSatisfies("forum.write", "forum.moderate")).toBe(false);
    expect(permissionSatisfies("forum.moderate", "admin.users")).toBe(false);
    expect(permissionSatisfies("gate.points", "gate.reply")).toBe(false);
    expect(permissionSatisfies("forum.moderate", "forum.report")).toBe(false);
  });

  it("未知键一律不满足（脏键不得凭空授权）", () => {
    expect(permissionSatisfies("p1", "forum.read")).toBe(false);
    expect(permissionSatisfies("forum.read", "y")).toBe(false);
    expect(isKnownPermission("p1")).toBe(false);
  });
});

describe("内置角色与基线授权", () => {
  it("内置角色恰为 guest / member / admin，muted 不再是角色", () => {
    const builtin = ROLE_DEFINITIONS.filter((r) => r.kind === "builtin").map((r) => r.key);
    expect(builtin.sort()).toEqual([...BUILTIN_ROLE_KEYS].sort());
    expect(ROLE_DEFINITIONS.some((r) => r.key === "muted")).toBe(false);
  });

  it("角色定义不带旧站信息；团队角色不是内置数据", () => {
    for (const r of ROLE_DEFINITIONS) {
      expect(Object.keys(r).sort(), r.key).toEqual(["description", "key", "kind", "name"]);
    }
    expect(ROLE_DEFINITIONS.some((r) => r.key.startsWith("team-"))).toBe(false);
  });

  it("基线授权只引用词汇表内的权限点", () => {
    for (const [role, keys] of Object.entries(DEFAULT_ROLE_GRANTS)) {
      expect(new Set(keys).size, `${role} 授权重复`).toBe(keys.length);
      for (const k of keys) expect(isKnownPermission(k), `${role} → ${k}`).toBe(true);
    }
  });

  it("基线：游客不能写，会员不拥有后台与版主权限，管理员拥有后台入口", () => {
    expect(DEFAULT_ROLE_GRANTS.guest).not.toContain("forum.write");
    expect(DEFAULT_ROLE_GRANTS.member).toContain("forum.write");
    expect(DEFAULT_ROLE_GRANTS.member).not.toContain("site.admin");
    expect(DEFAULT_ROLE_GRANTS.member).not.toContain("forum.moderate");
    expect(DEFAULT_ROLE_GRANTS.admin).toContain("site.admin");
  });

  it("站点设置默认值：邀请制、积分显示名、门控手续费 0", () => {
    expect(DEFAULT_SITE_SETTINGS["register.mode"]).toEqual({ mode: "invite" });
    expect(DEFAULT_SITE_SETTINGS["points.gate_fee_rate"]).toEqual({ rate: 0 });
    expect(DEFAULT_SITE_SETTINGS["points.name"]).toBeDefined();
    expect(DEFAULT_SITE_SETTINGS["limits"]).toBe(DEFAULT_LIMITS); // 默认限制只有一份
  });

  it("版块可见性策略取值", () => {
    expect([...READ_POLICIES]).toEqual(["inherit", "public", "members", "restricted"]);
    expect([...WRITE_POLICIES]).toEqual(["inherit", "members", "restricted"]);
    expect([...REVIEW_POLICIES]).toEqual(["inherit", "none", "threads", "all"]);
  });
});
