// @vitest-environment node
/** 私信管理（M10 补做）：pmStats / recentMessages 覆盖。禁止发私信 = 用户管理页的 mute 限制（语义为全站禁言）。 */
import { sql } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { loadSubject } from "@/lib/authz/subject";
import { deleteMessage, pmStats, recentMessages } from "./admin";
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
});
