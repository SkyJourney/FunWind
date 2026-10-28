// @vitest-environment node
/**
 * 聊天消息游标分页集成测试（M10.7 Step 3c）：messagesBefore 的批次边界、升序输出、hasMore 判定、
 * 不重不漏，以及成员资格校验 isConversationMember。
 */
import "@/modules";
import { conversationMembers, conversations, DEMO, getWebDb, messages } from "@funwind/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { CHAT_BATCH, isConversationMember, messagesBefore } from "./queries";

let tdb: TempDb;
let convId: number;
const db = () => getWebDb();
const TOTAL = 75;

beforeAll(async () => {
  tdb = await setupTempDb();
  const [header] = await db()
    .insert(conversations)
    .values({ pairKey: "chat-batch", lastMessageAt: sql`NOW()`, createdAt: sql`NOW()` });
  convId = header.insertId;
  await db()
    .insert(conversationMembers)
    .values([
      { conversationId: convId, userId: DEMO.member },
      { conversationId: convId, userId: DEMO.alice },
    ]);
  for (let i = 1; i <= TOTAL; i++) {
    await db()
      .insert(messages)
      .values({
        conversationId: convId,
        senderId: i % 2 === 0 ? DEMO.member : DEMO.alice,
        body: `消息 ${i}`,
        createdAt: sql`NOW()`,
      });
  }
  // 另一个会话里的消息不应混进来
  const [other] = await db()
    .insert(conversations)
    .values({ pairKey: "chat-other", lastMessageAt: sql`NOW()`, createdAt: sql`NOW()` });
  await db()
    .insert(messages)
    .values({
      conversationId: other.insertId,
      senderId: DEMO.alice,
      body: "别的会话",
      createdAt: sql`NOW()`,
    });
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("messagesBefore（M10.7）", () => {
  it("缺省取最新一批：30 条、升序（旧→新），末尾是最新消息，hasMore=true", async () => {
    const b = await messagesBefore(convId, null);
    expect(b.items).toHaveLength(CHAT_BATCH);
    expect(b.hasMore).toBe(true);
    expect(b.items.at(-1)!.body).toBe(`消息 ${TOTAL}`);
    expect(b.items[0]!.body).toBe(`消息 ${TOTAL - CHAT_BATCH + 1}`);
    const ids = b.items.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
  });

  it("以最旧一条的 id 作游标逐批往前：30 / 30 / 15，只有最后一批 hasMore=false，不重不漏", async () => {
    const batches = [];
    let cursor: number | null = null;
    for (let i = 0; i < 3; i++) {
      const b = await messagesBefore(convId, cursor);
      batches.push(b);
      cursor = b.items[0]!.id;
    }
    expect(batches.map((b) => b.items.length)).toEqual([30, 30, 15]);
    expect(batches.map((b) => b.hasMore)).toEqual([true, true, false]);
    const all = batches.flatMap((b) => b.items.map((m) => m.id));
    expect(new Set(all).size).toBe(TOTAL);
    // 越过最旧一条：空批
    expect(await messagesBefore(convId, cursor)).toEqual({ items: [], hasMore: false });
  });

  it("恰好整批的边界：75 条、limit=25 → 三批都满且最后一批 hasMore=false（多取 1 条判定不误报）", async () => {
    const first = await messagesBefore(convId, null, 25);
    const second = await messagesBefore(convId, first.items[0]!.id, 25);
    const third = await messagesBefore(convId, second.items[0]!.id, 25);
    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
    expect(third.items).toHaveLength(25);
  });

  it("只含本会话的消息", async () => {
    const all = (await messagesBefore(convId, null, 100)).items;
    expect(all).toHaveLength(TOTAL);
    expect(all.some((m) => m.body === "别的会话")).toBe(false);
  });
});

describe.skipIf(skipDb)("isConversationMember（M10.7）", () => {
  it("成员为 true，非成员与不存在的会话为 false", async () => {
    expect(await isConversationMember(DEMO.member, convId)).toBe(true);
    expect(await isConversationMember(DEMO.team, convId)).toBe(false);
    expect(await isConversationMember(DEMO.member, 9_999_999)).toBe(false);
  });
});
