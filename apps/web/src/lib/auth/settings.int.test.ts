// @vitest-environment node
/**
 * 注册策略读取（auth/settings.ts，M11.3）：新键 register.policy、旧键 register.mode 兼容、坏配置回落。
 * 真实 MySQL：验证 site_settings 里同时存在新旧键时的取舍，而不只是纯函数。
 */
import "@/modules";
import { eq, sql } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { getRegisterMode, getRegisterPolicy } from "./settings";

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
