// @vitest-environment node
import { and, eq, sql } from "drizzle-orm";
import { DEMO, getWebDb, notificationPreferences, themePackages, userProfiles } from "@funwind/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { takePreferenceRateLimit } from "@/lib/auth/preference-ratelimit";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { getCurrentUser } from "@/lib/auth/session";
import { invalidateThemeCatalog } from "@/lib/theme/catalog";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { PATCH } from "./route";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));

const patch = (body: unknown) =>
  new Request("http://localhost:3100/api/settings/preferences", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const readProfile = async () => {
  const [row] = await getWebDb()
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, DEMO.member));
  return row;
};

// 所有写入仅连接 setupTempDb 创建的独立随机测试库，不读取或更改开发库偏好。
describe.skipIf(skipDb)("偏好 PATCH 持久化边界", () => {
  let tdb: TempDb;
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    invalidateThemeCatalog();
    resetRateLimiter();
    await tdb?.teardown();
  });
  beforeEach(async () => {
    resetRateLimiter();
    invalidateThemeCatalog();
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: DEMO.member,
      username: "demo_member",
      email: null,
      emailVerified: false,
      passwordHashIsSet: false,
    });
    await getWebDb()
      .insert(userProfiles)
      .values({ userId: DEMO.member, themePack: "default", pmPolicy: "all", location: "保留资料" })
      .onDuplicateKeyUpdate({
        set: { themePack: "default", pmPolicy: "all", location: "保留资料" },
      });
    await getWebDb()
      .delete(notificationPreferences)
      .where(eq(notificationPreferences.userId, DEMO.member));
    await getWebDb().insert(notificationPreferences).values({
      userId: DEMO.member,
      type: "reply",
      channel: "email",
      enabled: true,
    });
  });

  it.each([
    { kind: "notif", type: "reply", channel: "email", enabled: false },
    { kind: "pmPolicy", pmPolicy: "off" },
    { kind: "themePack", pack: "qy2010" },
  ])("用户额度耗尽后 %j 返回 429，已有偏好和整份 profile 均不改变", async (body) => {
    const before = await readProfile();
    for (let i = 0; i < 60; i++) takePreferenceRateLimit(DEMO.member);
    const response = await PATCH(patch(body));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await readProfile()).toEqual(before);
    const [notification] = await getWebDb()
      .select({ enabled: notificationPreferences.enabled })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, DEMO.member),
          eq(notificationPreferences.type, "reply"),
          eq(notificationPreferences.channel, "email"),
        ),
      );
    expect(notification).toEqual({ enabled: true });
  });

  it("有效主题经共享服务持久化，只更新主题列，不覆盖 PM 策略与资料", async () => {
    const before = await readProfile();
    const response = await PATCH(patch({ kind: "themePack", pack: "qy2010" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, pack: "qy2010" });
    expect(await readProfile()).toEqual({ ...before, themePack: "qy2010" });
  });

  it("停用的动态主题返回原 400，数据库偏好不改变", async () => {
    const id = "f08-disabled";
    await getWebDb()
      .insert(themePackages)
      .values({
        id,
        name: "停用主题测试",
        description: "",
        schemaVersion: 1,
        definition: { surfaces: {}, pwa: { themeColor: "#123456", backgroundColor: "#f0f0f0" } },
        assets: [],
        enabled: false,
        isBuiltin: false,
        revision: 1,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      });
    invalidateThemeCatalog();
    const before = await readProfile();
    try {
      const response = await PATCH(patch({ kind: "themePack", pack: id }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
      expect(await readProfile()).toEqual(before);
    } finally {
      await getWebDb().delete(themePackages).where(eq(themePackages.id, id));
      invalidateThemeCatalog();
    }
  });

  it("私信策略仅修改目标列；缺少 profile 仍成功但不补建，保留既有语义", async () => {
    const before = await readProfile();
    const response = await PATCH(patch({ kind: "pmPolicy", pmPolicy: "following" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, pmPolicy: "following" });
    expect(await readProfile()).toEqual({ ...before, pmPolicy: "following" });

    await getWebDb().delete(userProfiles).where(eq(userProfiles.userId, DEMO.member));
    const noProfile = await PATCH(patch({ kind: "pmPolicy", pmPolicy: "off" }));
    expect(noProfile.status).toBe(200);
    expect(await noProfile.json()).toEqual({ ok: true, pmPolicy: "off" });
    expect(await readProfile()).toBeUndefined();
  });
});
