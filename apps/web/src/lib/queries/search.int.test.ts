// @vitest-environment node
/**
 * 站内搜索集成测试（M8 S7）：中日文命中（seed 词表）、可见性硬约束
 * （受限版块 904 / 隐藏主题 / 待审 / 不上目录 905 不出现在任何结果）、分页与排序。
 */
import { eq } from "drizzle-orm";
import { getWebDb, threads } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { cleanQuery, searchThreads } from "./search";

let tdb: TempDb;
let guest: Subject;
let team: Subject;

beforeAll(async () => {
  tdb = await setupTempDb();
  guest = {
    userId: null,
    roles: [{ key: "guest", scopeId: 0 }],
    restrictions: [],
    emailVerified: false,
    registerMode: "invite",
  };
  team = await loadSubject(90006);
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("搜索查询构造器", () => {
  it("cleanQuery：去空白、截断 64", () => {
    expect(cleanQuery("  刀剣乱舞 ")).toBe("刀剣乱舞");
    expect(cleanQuery("x".repeat(80))).toHaveLength(64);
    expect(cleanQuery("   ")).toBe("");
  });
});

describe.skipIf(skipDb)("搜索：命中与可见性", () => {
  it("游客搜「青翼」：命中标题含它的公开主题", async () => {
    const r = await searchThreads(guest, "青翼");
    expect(r.emptyQuery).toBe(false);
    expect(r.total).toBeGreaterThanOrEqual(1);
    expect(r.hits.some((h) => h.title.includes("青翼"))).toBe(true);
  });

  it("游客搜「刀剣乱舞」：正文命中（via=body）折叠到主题", async () => {
    const r = await searchThreads(guest, "刀剣乱舞");
    expect(r.total).toBeGreaterThanOrEqual(1);
    expect(r.hits.some((h) => h.via === "body")).toBe(true);
  });

  it("可见性硬约束：受限版块（904）内容对游客零命中，对 team（可读 904）命中", async () => {
    // seed 900005「[内部] 本季度字幕分工表」在 904，正文「仅字幕组可见」
    const asGuest = await searchThreads(guest, "字幕分工");
    expect(asGuest.hits.find((h) => h.id === 900005)).toBeUndefined();
    const asGuest2 = await searchThreads(guest, "仅字幕组可见");
    expect(asGuest2.hits.find((h) => h.id === 900005)).toBeUndefined();

    const asTeam = await searchThreads(team, "字幕分工");
    expect(asTeam.hits.find((h) => h.id === 900005)).toBeDefined();
  });

  it("隐藏/删除的主题不进结果；不上目录版块（905）不进结果", async () => {
    // seed 900006「[不上目录] 隐藏版块里的帖子」在 905（is_listed=0）
    const r = await searchThreads(guest, "隐藏版块");
    expect(r.hits.find((h) => h.id === 900006)).toBeUndefined();

    // 自建夹具：隐藏主题（公开版块 901）
    const [hidden] = (await getWebDb().insert(threads).values({
      forumId: 901,
      authorId: 90001,
      title: "M8搜索隐藏夹具zzz",
      state: "hidden",
      createdAt: "2026-10-25 00:00:00",
      lastPostedAt: "2026-10-25 00:00:00",
    })) as unknown as [{ insertId: number }];
    const r2 = await searchThreads(guest, "M8搜索隐藏夹具");
    expect(r2.hits.find((h) => h.id === Number(hidden.insertId))).toBeUndefined();
    await getWebDb()
      .delete(threads)
      .where(eq(threads.id, Number(hidden.insertId)));
  });

  it("门控隐藏内容不可搜：隐藏正文词只存在于 post_gates.hidden_md", async () => {
    // seed 900004 门控帖：hidden_md 含「需要 10 积分才能解锁的隐藏正文」
    const r = await searchThreads(guest, "才能解锁的隐藏正文");
    expect(r.hits.find((h) => h.id === 900004)).toBeUndefined();
  });

  it("时间排序切换与分页：total 一致、page 收束", async () => {
    const rel = await searchThreads(guest, "青翼");
    const byTime = await searchThreads(guest, "青翼", { sort: "time" });
    expect(byTime.total).toBe(rel.total);
    if (rel.totalPages > 1) {
      const p2 = await searchThreads(guest, "青翼", { page: 2 });
      expect(p2.page).toBe(2);
      const ids1 = new Set(rel.hits.map((h) => h.id));
      expect(p2.hits.some((h) => !ids1.has(h.id))).toBe(true);
    }
  });
});
