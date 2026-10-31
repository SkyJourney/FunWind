// @vitest-environment node
/** 用户主题包偏好（M11）：profile 行缺失时 upsert 补建、null = 跟随站点、库内未知 id 读回 null。 */
import { eq } from "drizzle-orm";
import { DEMO, getWebDb, userProfiles } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { getUserThemePack, setUserThemePack } from "./theme-pref";

let tdb: TempDb;

beforeAll(async () => {
  tdb = await setupTempDb();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("用户主题包偏好（theme-pref）", () => {
  it("无 profile 行的用户：读回 null；写入时补建行", async () => {
    // demo_member 只建了 users 行（种子仅给 alice 建 profile）
    await getWebDb().delete(userProfiles).where(eq(userProfiles.userId, DEMO.member));
    expect(await getUserThemePack(DEMO.member)).toBeNull();

    await setUserThemePack(DEMO.member, "qy2010");
    const [row] = await getWebDb()
      .select({ themePack: userProfiles.themePack, pmPolicy: userProfiles.pmPolicy })
      .from(userProfiles)
      .where(eq(userProfiles.userId, DEMO.member));
    expect(row).toEqual({ themePack: "qy2010", pmPolicy: "all" }); // 其余列取默认，不破坏既有语义
  });

  it("已有 profile 行：只改 theme_pack，其他资料不动；null = 跟随站点默认", async () => {
    await getWebDb()
      .update(userProfiles)
      .set({ location: "东京" })
      .where(eq(userProfiles.userId, DEMO.member));
    await setUserThemePack(DEMO.member, null);
    const [row] = await getWebDb()
      .select({ themePack: userProfiles.themePack, location: userProfiles.location })
      .from(userProfiles)
      .where(eq(userProfiles.userId, DEMO.member));
    expect(row).toEqual({ themePack: null, location: "东京" });
  });

  it("库内残留未注册的包 id → 读回 null（注册表删包不需迁移数据）", async () => {
    await getWebDb()
      .update(userProfiles)
      .set({ themePack: "retired-pack" })
      .where(eq(userProfiles.userId, DEMO.member));
    // react cache() 只在同一请求内生效；测试里每次调用都是独立 cache scope，直接读库
    expect(await getUserThemePack(DEMO.member)).toBeNull();
  });
});
