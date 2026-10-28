// @vitest-environment node
/**
 * 会话列表分页集成测试（M10.7 Step 3b）：conversationPage 的分页边界、hasMore 判定、
 * lastMessageAt 相同时的稳定排序（id 作第二键）、不重不漏，以及旧入口 conversationList 的 50 条口径不变。
 */
import "@/modules";
import { sql } from "drizzle-orm";
import { conversationMembers, conversations, DEMO, getWebDb } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { CONVERSATIONS_PER_PAGE, conversationList, conversationPage } from "./queries";

let tdb: TempDb;
const db = () => getWebDb();
const TOTAL = 45;

beforeAll(async () => {
  tdb = await setupTempDb();
  // 45 个会话：DEMO.member 与 DEMO.alice；每 3 个会话共用同一个 last_message_at（制造并列，验证翻页稳定）
  for (let i = 0; i < TOTAL; i++) {
    const [header] = await db()
      .insert(conversations)
      .values({
        pairKey: `e2e-page-${i}`,
        lastMessageAt: sql`DATE_SUB('2026-10-28 12:00:00', INTERVAL ${Math.floor(i / 3)} MINUTE)`,
        createdAt: sql`NOW()`,
      });
    await db()
      .insert(conversationMembers)
      .values([
        { conversationId: header.insertId, userId: DEMO.member },
        { conversationId: header.insertId, userId: DEMO.alice },
      ]);
  }
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("conversationPage（M10.7）", () => {
  it("45 个会话 → 20 / 20 / 5 三页，仅前两页 hasMore；越界页为空", async () => {
    const p1 = await conversationPage(DEMO.member, 1);
    const p2 = await conversationPage(DEMO.member, 2);
    const p3 = await conversationPage(DEMO.member, 3);
    const p4 = await conversationPage(DEMO.member, 4);
    expect([p1.items.length, p2.items.length, p3.items.length, p4.items.length]).toEqual([
      CONVERSATIONS_PER_PAGE,
      CONVERSATIONS_PER_PAGE,
      TOTAL - CONVERSATIONS_PER_PAGE * 2,
      0,
    ]);
    expect([p1.hasMore, p2.hasMore, p3.hasMore, p4.hasMore]).toEqual([true, true, false, false]);
  });

  it("不重不漏：并列的 lastMessageAt 也按 id 倒序稳定排列", async () => {
    const all = (await Promise.all([1, 2, 3].map((p) => conversationPage(DEMO.member, p)))).flatMap(
      (r) => r.items,
    );
    const ids = all.map((c) => c.conversationId);
    expect(new Set(ids).size).toBe(TOTAL);
    // 全序：先按 lastMessageAt 倒序，并列时按会话 id 倒序
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1]!;
      const b = all[i]!;
      const sameTime = a.lastMessageAt === b.lastMessageAt;
      expect(
        a.lastMessageAt! > b.lastMessageAt! || (sameTime && a.conversationId > b.conversationId),
      ).toBe(true);
    }
  });

  it("页码异常（0 / 负数 / 小数）收束为第 1 页，不产生非法 OFFSET", async () => {
    const first = (await conversationPage(DEMO.member, 1)).items.map((c) => c.conversationId);
    for (const raw of [0, -3, Number.NaN, 1.9]) {
      const r = await conversationPage(DEMO.member, raw);
      expect(r.page).toBe(1);
      expect(r.items.map((c) => c.conversationId)).toEqual(first);
    }
  });

  it("旧入口 conversationList 仍是最近 50 个（口径不变，与分页首页顺序一致）", async () => {
    const legacy = await conversationList(DEMO.member);
    expect(legacy).toHaveLength(TOTAL);
    const p1 = await conversationPage(DEMO.member, 1);
    expect(legacy.slice(0, CONVERSATIONS_PER_PAGE).map((c) => c.conversationId)).toEqual(
      p1.items.map((c) => c.conversationId),
    );
  });

  it("只返回自己所在的会话", async () => {
    const stranger = await conversationPage(DEMO.team, 1);
    expect(stranger.items).toHaveLength(0);
  });
});
