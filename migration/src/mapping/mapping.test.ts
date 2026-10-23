import { isKnownPermission } from "@funwind/db";
import { describe, expect, it } from "vitest";
import { LEGACY_CONDITION_KEYS, LEGACY_PERMISSION_KEYS } from "./legacy-permissions.js";
import { BUILTIN_GIDS, GUEST_GID, MUTED_GID, TEAM_ROLES } from "./legacy-roles.js";

describe("旧站映射表", () => {
  it("旧权限键只映射到词汇表内的权限点（防止词汇表演进后映射悬空）", () => {
    for (const [rkey, perms] of Object.entries(LEGACY_PERMISSION_KEYS)) {
      for (const p of perms) expect(isKnownPermission(p), `${rkey} → ${p}`).toBe(true);
    }
  });

  it("提权护栏：没有任何旧键映射到 forum.moderate / site.admin", () => {
    const all = Object.values(LEGACY_PERMISSION_KEYS).flat();
    expect(all).not.toContain("forum.moderate");
    expect(all).not.toContain("site.admin");
    expect(LEGACY_PERMISSION_KEYS).not.toHaveProperty("operate_thread");
  });

  it("条件参数键不与权限键重叠，目标是权限点或 thread.* 动作", () => {
    for (const [k, c] of Object.entries(LEGACY_CONDITION_KEYS)) {
      expect(LEGACY_PERMISSION_KEYS, k).not.toHaveProperty(k);
      expect(isKnownPermission(c.target) || c.target.startsWith("thread."), c.target).toBe(true);
    }
  });

  it("旧 gid 只属于一个角色；禁止发言组不是任何角色（防止 23/38 互换类错误）", () => {
    const seen = new Map<number, string>();
    const add = (gid: number, role: string) => {
      expect(seen.has(gid), `gid ${gid} 重复：${seen.get(gid)} / ${role}`).toBe(false);
      seen.set(gid, role);
    };
    for (const [role, gids] of Object.entries(BUILTIN_GIDS)) gids.forEach((g) => add(g, role));
    for (const t of TEAM_ROLES) add(t.gid, t.key);
    expect(seen.has(MUTED_GID)).toBe(false);
    expect(seen.get(GUEST_GID)).toBe("guest");
    // 旧库实测：23 = 实习组、38 = 策划组
    expect(seen.get(23)).toBe("team-intern");
    expect(seen.get(38)).toBe("team-planning");
  });

  it("团队角色键唯一且以 team- 开头，不占用内置角色键", () => {
    const keys = TEAM_ROLES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^team-/);
  });
});
