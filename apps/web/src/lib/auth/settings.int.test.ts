// @vitest-environment node
/**
 * 注册策略读取（auth/settings.ts，M11.3）：新键 register.policy、旧键 register.mode 兼容、坏配置回落。
 * 真实 MySQL：验证 site_settings 里同时存在新旧键时的取舍，而不只是纯函数。
 * M11.4 Step 2 追加：开放注册窗口的读取侧叠加（生效值 vs 站点原值、窗口边界、顶栏联动）。
 */
import "@/modules";
import { eq, sql } from "drizzle-orm";
import { campaigns, getWebDb, siteSettings } from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { getSiteChrome, invalidateSiteChrome } from "@/lib/chrome/site-chrome";
import { getRegisterMode, getRegisterPolicy, getSiteRegisterPolicy } from "./settings";

let tdb: TempDb;
const db = () => getWebDb();

beforeAll(async () => {
  tdb = await setupTempDb();
});

afterAll(async () => {
  await tdb?.teardown();
});

afterEach(async () => {
  await db().delete(siteSettings).where(eq(siteSettings.key, "register.policy"));
  await db().delete(siteSettings).where(eq(siteSettings.key, "register.mode"));
});

async function put(key: string, value: unknown) {
  await db()
    .insert(siteSettings)
    .values({ key, value: value as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: value as object } });
}

describe.skipIf(skipDb)("注册策略读取", () => {
  it("两个键都没有 → 邀请制默认（升级后行为零变化）", async () => {
    expect(await getRegisterPolicy()).toEqual({ open: false, invite: true, verifyEmail: false });
  });

  it("只有旧 register.mode=open → 映射为开放且要求验证", async () => {
    await put("register.mode", { mode: "open" });
    expect(await getRegisterPolicy()).toEqual({ open: true, invite: false, verifyEmail: true });
  });

  it("新旧键同时存在 → 以新键为准", async () => {
    await put("register.mode", { mode: "open" });
    await put("register.policy", { open: false, invite: true, verifyEmail: false });
    expect(await getRegisterPolicy()).toEqual({ open: false, invite: true, verifyEmail: false });
  });

  it("新键写坏 → 回落邀请制并告警，不回头读旧键放开注册", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await put("register.mode", { mode: "open" });
    await put("register.policy", { open: "yes" });
    expect(await getRegisterPolicy()).toEqual({ open: false, invite: true, verifyEmail: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("register.policy"));
    warn.mockRestore();
  });

  it("双关也是合法状态（站长 Q8：新增「不开放注册」）", async () => {
    await put("register.policy", { open: false, invite: false, verifyEmail: false });
    expect(await getRegisterPolicy()).toEqual({ open: false, invite: false, verifyEmail: false });
  });
});

describe.skipIf(skipDb)("旧单选视图 getRegisterMode（由策略派生）", () => {
  it("仅开放 → open；其余（仅邀请 / 双开 / 双关）→ invite", async () => {
    await put("register.policy", { open: true, invite: false, verifyEmail: true });
    expect(await getRegisterMode()).toBe("open");
  });
});

describe.skipIf(skipDb)("开放注册窗口叠加（M11.4 Step 2）", () => {
  const offset = (seconds: number) => sql`NOW() + INTERVAL ${seconds} SECOND`;

  async function addWindow(
    over: Partial<{
      enabled: boolean;
      startSeconds: number;
      endSeconds: number | null;
      name: string;
    }> = {},
  ) {
    await db()
      .insert(campaigns)
      .values({
        name: over.name ?? "窗口集成测试",
        effect: "register.open",
        config: {},
        startsAt: offset(over.startSeconds ?? -3600),
        endsAt: over.endSeconds === null ? null : offset(over.endSeconds ?? 3600),
        enabled: over.enabled ?? true,
        revision: 1,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      });
  }

  afterEach(async () => {
    await db().delete(campaigns);
    invalidateSiteChrome();
  });

  it("无窗口：生效值 = 站点原值（两个读取入口一致）", async () => {
    await put("register.policy", { open: false, invite: true, verifyEmail: false });
    const site = await getSiteRegisterPolicy();
    expect(site).toEqual({ open: false, invite: true, verifyEmail: false });
    expect(await getRegisterPolicy()).toEqual(site);
  });

  it("窗口生效：生效值放开注册且强制验证（D3）；站点原值与库内设置不被改写", async () => {
    await put("register.policy", { open: false, invite: true, verifyEmail: false });
    await addWindow();
    expect(await getRegisterPolicy()).toEqual({ open: true, invite: true, verifyEmail: true });
    expect(await getSiteRegisterPolicy()).toEqual({
      open: false,
      invite: true,
      verifyEmail: false,
    });
    const [row] = await db()
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.key, "register.policy"));
    expect(row?.value).toEqual({ open: false, invite: true, verifyEmail: false });
  });

  it("站点已开放时窗口不收紧（verifyEmail 跟随站点设置）", async () => {
    await put("register.policy", { open: true, invite: false, verifyEmail: false });
    await addWindow();
    expect(await getRegisterPolicy()).toEqual({ open: true, invite: false, verifyEmail: false });
  });

  it("已结束 / 未开始 / 停用的窗口不影响生效值", async () => {
    await put("register.policy", { open: false, invite: true, verifyEmail: false });
    const site = { open: false, invite: true, verifyEmail: false };
    await addWindow({ endSeconds: -1 });
    expect(await getRegisterPolicy()).toEqual(site);
    await db().delete(campaigns);
    await addWindow({ startSeconds: 3600 });
    expect(await getRegisterPolicy()).toEqual(site);
    await db().delete(campaigns);
    await addWindow({ enabled: false });
    expect(await getRegisterPolicy()).toEqual(site);
  });

  it("窗口边界与读取口径一致：开始恰为 NOW 生效，结束恰为 NOW 不生效（左闭右开）", async () => {
    await put("register.policy", { open: false, invite: true, verifyEmail: false });
    await addWindow({ startSeconds: 0, endSeconds: 3600 });
    expect(await getRegisterPolicy()).toEqual({ open: true, invite: true, verifyEmail: true });
    await db().delete(campaigns);
    await addWindow({ startSeconds: -3600, endSeconds: 0 });
    expect(await getRegisterPolicy()).toEqual({ open: false, invite: true, verifyEmail: false });
  });

  it("顶栏「注册」入口随窗口开闭（双关站点 + 窗口 → 开；删除 + 失效缓存 → 关）", async () => {
    await put("register.policy", { open: false, invite: false, verifyEmail: false });
    invalidateSiteChrome();
    expect((await getSiteChrome()).registrationOpen).toBe(false);
    await addWindow();
    invalidateSiteChrome();
    expect((await getSiteChrome()).registrationOpen).toBe(true);
    await db().delete(campaigns);
    invalidateSiteChrome();
    expect((await getSiteChrome()).registrationOpen).toBe(false);
  });
});
