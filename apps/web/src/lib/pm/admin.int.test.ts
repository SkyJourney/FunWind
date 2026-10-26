// @vitest-environment node
/** 私信管理（M10 补做）：pmStats / recentMessages / banPmForUser 覆盖。 */
import { eq, sql } from "drizzle-orm";
import { getWebDb, siteSettings, userRestrictions } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { banPmForUser, deleteMessage, pmStats, recentMessages } from "./admin";
import { sendMessage } from "./service";

let tdb: TempDb;

beforeAll(async () => {
  tdb = await setupTempDb();
  const value = {
    titleMax: 100,
    bodyMax: 50000,
    roles: {
      member: {
        postIntervalSec: 0,
        threadsPerDay: 0,
        uploadsPerDay: 20,
        editWindowSec: 0,
        pmPerDay: 0,
      },
      admin: {
        postIntervalSec: 0,
        threadsPerDay: 0,
        uploadsPerDay: 0,
        editWindowSec: 0,
        pmPerDay: 0,
      },
    },
  };
  await getWebDb()
    .insert(siteSettings)
    .values({ key: "limits", value: value as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: value as object, updatedAt: sql`NOW()` } });
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("私信管理辅助（M10 补做）", () => {
  it("pmStats：会话/消息/今日计数", async () => {
    await sendMessage(await loadSubject(90001), 90006, "统计前消息");
    const stats = await pmStats();
    expect(stats.conversations).toBeGreaterThanOrEqual(1);
    expect(stats.messages).toBeGreaterThanOrEqual(1);
    expect(stats.today).toBeGreaterThanOrEqual(1);
  });

  it("recentMessages：倒序列出最近消息", async () => {
    const rows = await recentMessages(10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].id).toBeGreaterThan(rows[i].id);
    }
  });

  it("deleteMessage：不存在的消息 → AdminError", async () => {
    await expect(
      deleteMessage({ userId: 90004, via: "admin", ip: null }, 99999999, "理由"),
    ).rejects.toMatchObject({
      message: "消息不存在",
    });
  });

  it("banPmForUser：mute 限制落行（复用 M9 限制管理），再发私信被禁言拦截", async () => {
    await banPmForUser({ userId: 90004, via: "admin", ip: null }, 90002, "滥发私信");
    const rows = await getWebDb()
      .select()
      .from(userRestrictions)
      .where(eq(userRestrictions.userId, 90002));
    expect(rows.some((r) => r.kind === "mute")).toBe(true);

    // 禁言（写类权限拦截 pm.send）
    const xiaoyi = await loadSubject(90002);
    const r = await sendMessage(xiaoyi, 90001, "被禁言后发不出");
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
  });
});

// loadSubject 延迟引入（避免顶层循环依赖）
async function loadSubject(uid: number) {
  const { loadSubject } = await import("@/lib/authz/subject");
  return loadSubject(uid);
}
