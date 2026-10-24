// @vitest-environment node
/**
 * limits 加载器的真实 MySQL 集成测试（M6.1）：默认值、自定义覆盖、无效回落并告警、键被删除、
 * 以及 limitsFor 把"主体的角色绑定 + 版块作用域 + 配置"串起来的端到端结果。
 */
import { eq, sql } from "drizzle-orm";
import { DEMO, getWebDb, siteSettings, userRoles } from "@funwind/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";
import { loadSubject } from "@/lib/authz/subject";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { DEFAULT_LIMITS_CONFIG } from "./config";
import { getLimitsConfig, limitsFor } from "./load";

let tdb: TempDb;
const setLimits = (value: unknown) =>
  getWebDb()
    .insert(siteSettings)
    .values({ key: "limits", value: value as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: value as object, updatedAt: sql`NOW()` } });
const dropLimits = () => getWebDb().delete(siteSettings).where(eq(siteSettings.key, "limits"));
const lim = (postIntervalSec: number, threadsPerDay: number, uploadsPerDay: number) => ({
  postIntervalSec,
  threadsPerDay,
  uploadsPerDay,
  editWindowSec: 0,
});

describe.skipIf(skipDb)("limits 加载 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });
  beforeEach(() => invalidateAuthzSnapshot());

  it("bootstrap 写入的默认值就是代码里的默认配置（零数据部署开箱可用）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await setLimits(DEFAULT_LIMITS_CONFIG);
      expect(await getLimitsConfig()).toEqual(DEFAULT_LIMITS_CONFIG);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("键被删除 → 默认值，且不告警（没配置过是正常的）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await dropLimits();
      expect(await getLimitsConfig()).toEqual(DEFAULT_LIMITS_CONFIG);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("合法的自定义配置生效", async () => {
    await setLimits({ titleMax: 60, bodyMax: 8000, roles: { member: lim(20, 10, 3) } });
    expect(await getLimitsConfig()).toEqual({
      titleMax: 60,
      bodyMax: 8000,
      roles: { member: lim(20, 10, 3) },
    });
  });

  it("无效配置 → 整体回落默认并告警（含出错路径），不抛错；对照：有效配置不告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // 缺少 uploadsPerDay：缺省补 0 会悄悄变成"不限"，所以必须整体无效
      await setLimits({
        titleMax: 60,
        bodyMax: 8000,
        roles: { member: { postIntervalSec: 1, threadsPerDay: 1 } },
      });
      expect(await getLimitsConfig()).toEqual(DEFAULT_LIMITS_CONFIG);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("roles.member.uploadsPerDay");
      warn.mockClear();
      await setLimits({ titleMax: 60, bodyMax: 8000, roles: { member: lim(1, 1, 1) } });
      await getLimitsConfig();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  describe("limitsFor：角色绑定 + 版块作用域 + 配置", () => {
    beforeAll(async () => {
      await setLimits({
        titleMax: 100,
        bodyMax: 50000,
        roles: { member: lim(5, 100, 20), admin: lim(0, 0, 0), [DEMO.teamRole]: lim(2, 500, 80) },
      });
    });

    it("普通会员：member 项；游客：回落到 member 项（不会变成不限）", async () => {
      expect(await limitsFor(await loadSubject(DEMO.xiaoyi), 901)).toMatchObject(lim(5, 100, 20));
      expect(await limitsFor(await loadSubject(null), 901)).toMatchObject(lim(5, 100, 20));
    });

    it("admin：不限（额度与间隔都是 0）", async () => {
      expect(await limitsFor(await loadSubject(DEMO.admin), 901)).toMatchObject(lim(0, 0, 0));
    });

    it("团队成员：与 member 合并取最宽松（间隔更短、额度更高）；站点级也只看全局绑定", async () => {
      const team = await loadSubject(DEMO.team);
      expect(await limitsFor(team, 904)).toMatchObject(lim(2, 500, 80));
      expect(await limitsFor(team)).toMatchObject(lim(2, 500, 80));
    });

    it("版块作用域的角色绑定只在该版块子树内放宽：绑在 904 的团队角色，在 901 里不生效", async () => {
      // 把 xiaoyi 绑到团队角色，作用域限定为版块 904
      await getWebDb()
        .insert(userRoles)
        .values({
          userId: DEMO.xiaoyi,
          roleKey: DEMO.teamRole,
          scopeId: DEMO.restrictedForum,
          grantedBy: DEMO.admin,
          grantedAt: sql`NOW()`,
        });
      const s = await loadSubject(DEMO.xiaoyi);
      expect(await limitsFor(s, DEMO.restrictedForum)).toMatchObject(lim(2, 500, 80));
      expect(await limitsFor(s, 901)).toMatchObject(lim(5, 100, 20));
      expect(await limitsFor(s)).toMatchObject(lim(5, 100, 20));
    });
  });
});
