// @vitest-environment node
/**
 * 注册/验证策略读取（auth/settings.ts 的读取函数，M9.5 补覆盖）：库值 both 分支与缺失回落。
 */
import "@/modules";
import { sql } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { getEmailVerificationMode, getRegisterMode } from "./settings";

let tdb: TempDb;
const db = () => getWebDb();

beforeAll(async () => {
  tdb = await setupTempDb();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("注册与验证策略读取", () => {
  it("email.verification：库值 always → always；缺失/未知 → open_only", async () => {
    // 默认（种子没写的键）→ open_only
    expect(await getEmailVerificationMode()).toBe("open_only");
    await db()
      .insert(siteSettings)
      .values({ key: "email.verification", value: { mode: "always" }, updatedAt: sql`NOW()` })
      .onDuplicateKeyUpdate({ set: { value: { mode: "always" } } });
    expect(await getEmailVerificationMode()).toBe("always");
  });

  it("register.mode：库值 open → open；缺失 → invite（默认邀请制）", async () => {
    expect(await getRegisterMode()).toBe("invite");
    await db()
      .insert(siteSettings)
      .values({ key: "register.mode", value: { mode: "open" }, updatedAt: sql`NOW()` })
      .onDuplicateKeyUpdate({ set: { value: { mode: "open" } } });
    expect(await getRegisterMode()).toBe("open");
  });
});
