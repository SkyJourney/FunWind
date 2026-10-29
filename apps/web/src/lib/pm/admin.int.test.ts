// @vitest-environment node
/** 私信管理（M10 补做）：pmStats / recentMessages 覆盖。禁止发私信 = 用户管理页的 mute 限制（语义为全站禁言）。 */
import { sql } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { loadSubject } from "@/lib/authz/subject";
import { deleteMessage, listPmMessagesPage, pmStats } from "./admin";
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

  it("listPmMessagesPage：倒序分页；uid 与用户名筛选下推（M9.5）", async () => {
    const all = await listPmMessagesPage({ page: 1 });
    expect(all.items.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < all.items.length; i++) {
      expect(all.items[i - 1].id).toBeGreaterThan(all.items[i].id);
    }
    const target = all.items[0];
    // uid 筛选
    const byUid = await listPmMessagesPage({ q: String(target.senderId), page: 1 });
    expect(byUid.items.every((m) => m.senderId === target.senderId)).toBe(true);
    // 不存在的用户 → unknownUser（与「无消息」区分）
    const missing = await listPmMessagesPage({ q: "不存在的用户xyz", page: 1 });
    expect(missing.unknownUser).toBe(true);
  });

  it("deleteMessage：不存在的消息 → AdminError", async () => {
    await expect(
      deleteMessage({ userId: 90004, via: "admin", ip: null }, 99999999, "理由"),
    ).rejects.toMatchObject({
      message: "消息不存在",
    });
  });
});
