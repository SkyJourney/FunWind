// @vitest-environment node
/**
 * requireAdmin 的真实 MySQL 集成测试（临时库 + 演示夹具）。
 * Next 的 redirect / notFound 在运行时靠抛特殊异常中断渲染，这里换成可断言的异常；
 * 登录态与请求头用模块级变量注入，权限判定走真实的评估器与授权快照。
 */
import { eq } from "drizzle-orm";
import { DEMO, getWebDb, roleGrants, roles, userRoles } from "@funwind/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { invalidateAuthzSnapshot } from "./snapshot";

let currentUserId: number | null = null;
let forwardedFor: string | null = null;

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: async () => (currentUserId === null ? null : { id: currentUserId }),
}));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => (name.toLowerCase() === "x-forwarded-for" ? forwardedFor : null),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { requireAdmin } from "./require-admin";

let tdb: TempDb;
const savedHops = process.env.TRUSTED_PROXY_HOPS;

describe.skipIf(skipDb)("requireAdmin · 真实 MySQL", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    if (savedHops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = savedHops;
    await tdb?.teardown();
  });
  beforeEach(() => {
    currentUserId = null;
    forwardedFor = null;
  });

  it("未登录 → 跳登录页（不是 404，体验上让人去登录）", async () => {
    await expect(requireAdmin()).rejects.toThrow("REDIRECT:/login");
    await expect(requireAdmin("admin.roles")).rejects.toThrow("REDIRECT:/login");
  });

  it("已登录但不是 admin → 404（不暴露后台存在）", async () => {
    for (const uid of [DEMO.member, DEMO.xiaoyi, DEMO.team, DEMO.alice]) {
      currentUserId = uid;
      await expect(requireAdmin(), `uid=${uid}`).rejects.toThrow("NOT_FOUND");
      await expect(requireAdmin("admin.roles"), `uid=${uid}`).rejects.toThrow("NOT_FOUND");
    }
  });

  it("admin → 通过，返回审计用的 actor（含可信 IP，取不到则 null）", async () => {
    currentUserId = DEMO.admin;
    forwardedFor = "198.51.100.9";
    await expect(requireAdmin()).resolves.toEqual({ userId: DEMO.admin, ip: "198.51.100.9" });
    await expect(requireAdmin("admin.roles")).resolves.toMatchObject({ userId: DEMO.admin });
    forwardedFor = null;
    await expect(requireAdmin()).resolves.toEqual({ userId: DEMO.admin, ip: null });
  });

  it("细分权限要叠加在 site.admin 之上：只有 admin.roles、没有 site.admin 的自定义角色一律 404", async () => {
    const db = getWebDb();
    await db
      .insert(roles)
      .values({ key: "roles-only", name: "仅角色管理", kind: "custom", description: "" });
    await db
      .insert(roleGrants)
      .values({ roleKey: "roles-only", permissionKey: "admin.roles", scopeId: 0 });
    await db.insert(userRoles).values({
      userId: DEMO.member,
      roleKey: "roles-only",
      scopeId: 0,
      grantedAt: "2026-10-24 00:00:00",
    });
    invalidateAuthzSnapshot();
    currentUserId = DEMO.member;
    // 有 admin.roles 也进不去：后台总开关 site.admin 是前提
    await expect(requireAdmin()).rejects.toThrow("NOT_FOUND");
    await expect(requireAdmin("admin.roles")).rejects.toThrow("NOT_FOUND");

    // 补上 site.admin 但缺 admin.roles → 只能过 requireAdmin()，过不了 requireAdmin("admin.roles")
    await db.delete(roleGrants).where(eq(roleGrants.roleKey, "roles-only"));
    await db
      .insert(roleGrants)
      .values({ roleKey: "roles-only", permissionKey: "site.admin", scopeId: 0 });
    invalidateAuthzSnapshot();
    await expect(requireAdmin()).resolves.toMatchObject({ userId: DEMO.member });
    await expect(requireAdmin("admin.roles")).rejects.toThrow("NOT_FOUND");
  });
});
