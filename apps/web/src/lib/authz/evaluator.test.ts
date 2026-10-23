import { describe, expect, it } from "vitest";
import { evaluate, isMutedBlocked, type GrantRow } from "./evaluator";

const G = (roleKey: string, permissionKey: string): GrantRow => ({ roleKey, permissionKey });

describe("evaluate · admin 短路", () => {
  it("admin 无需任何授权即放行任意权限点", () => {
    const r = evaluate({
      roleKeys: ["admin"],
      mutedActive: false,
      grants: [],
      permissionKey: "admin.roles",
    });
    expect(r.allowed).toBe(true);
  });

  it("admin 短路优先于 muted", () => {
    const r = evaluate({
      roleKeys: ["admin"],
      mutedActive: true,
      grants: [],
      permissionKey: "forum.write",
    });
    expect(r.allowed).toBe(true);
  });
});

describe("evaluate · muted 禁言", () => {
  it("封堵发帖类（forum.write/thread./pm.send/attachment.upload）", () => {
    for (const key of ["forum.write", "thread.create", "pm.send", "attachment.upload"]) {
      const r = evaluate({
        roleKeys: ["member", "muted"],
        mutedActive: true,
        grants: [G("member", key)],
        permissionKey: key,
      });
      expect(r.allowed).toBe(false);
    }
  });

  it("不封堵浏览（forum.read）", () => {
    const r = evaluate({
      roleKeys: ["member", "muted"],
      mutedActive: true,
      grants: [G("member", "forum.read")],
      permissionKey: "forum.read",
    });
    expect(r.allowed).toBe(true);
  });

  it("isMutedBlocked 分类正确", () => {
    expect(isMutedBlocked("forum.write")).toBe(true);
    expect(isMutedBlocked("thread.create")).toBe(true);
    expect(isMutedBlocked("forum.read")).toBe(false);
  });
});

describe("evaluate · 级别隐含（manage ⊃ write ⊃ read）", () => {
  it("forum.manage 授权满足 forum.read 检查", () => {
    const r = evaluate({
      roleKeys: ["member"],
      mutedActive: false,
      grants: [G("member", "forum.manage")],
      permissionKey: "forum.read",
    });
    expect(r.allowed).toBe(true);
  });

  it("forum.write 授权满足 forum.read，不满足 forum.manage", () => {
    const grants = [G("member", "forum.write")];
    expect(
      evaluate({ roleKeys: ["member"], mutedActive: false, grants, permissionKey: "forum.write" })
        .allowed,
    ).toBe(true);
    expect(
      evaluate({ roleKeys: ["member"], mutedActive: false, grants, permissionKey: "forum.manage" })
        .allowed,
    ).toBe(false);
  });

  it("跨资源不隐含（forum.manage ≠ admin.users）", () => {
    const r = evaluate({
      roleKeys: ["member"],
      mutedActive: false,
      grants: [G("member", "forum.manage")],
      permissionKey: "admin.users",
    });
    expect(r.allowed).toBe(false);
  });

  it("动作型权限点要求精确键", () => {
    const grants = [G("member", "pm.send")];
    expect(
      evaluate({ roleKeys: ["member"], mutedActive: false, grants, permissionKey: "pm.send" })
        .allowed,
    ).toBe(true);
    expect(
      evaluate({ roleKeys: ["member"], mutedActive: false, grants, permissionKey: "sign.use" })
        .allowed,
    ).toBe(false);
  });
});

describe("evaluate · 角色与默认拒绝", () => {
  it("授权的角色不匹配时不生效", () => {
    const r = evaluate({
      roleKeys: ["guest"],
      mutedActive: false,
      grants: [G("member", "pm.send")],
      permissionKey: "pm.send",
    });
    expect(r.allowed).toBe(false);
  });

  it("多角色任一允许即允许", () => {
    const r = evaluate({
      roleKeys: ["member", "team-subtitle"],
      mutedActive: false,
      grants: [G("team-subtitle", "forum.read")],
      permissionKey: "forum.read",
    });
    expect(r.allowed).toBe(true);
  });

  it("无匹配授权 → 默认拒绝", () => {
    const r = evaluate({
      roleKeys: ["guest"],
      mutedActive: false,
      grants: [],
      permissionKey: "pm.send",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("默认拒绝");
  });
});
