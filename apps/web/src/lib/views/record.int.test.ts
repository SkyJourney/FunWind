// @vitest-environment node
/**
 * 浏览量记录的真实 MySQL 测试（临时库）：可见主题计数并写入、作者不计、隐藏主题不计、同一访客去重。
 * 夹具：演示库里公开版块 901 中、作者为 alice 的一个可见主题（运行时查出，不写死编号）。
 */
import { and, eq } from "drizzle-orm";
import { DEMO, getWebDb, threads } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { recordThreadView, viewRuntime } from "./record";

let TID = 0;
let tdb: TempDb;
let guest: Subject, member: Subject, alice: Subject;
const views = async () =>
  (await getWebDb().select({ n: threads.viewCount }).from(threads).where(eq(threads.id, TID)))[0]!
    .n;
const rec = (s: Subject, ip: string | null = "203.0.113.7", now?: number) =>
  recordThreadView({ subject: s, threadId: TID, ip, now });

describe.skipIf(skipDb)("浏览量记录 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    [guest, member, alice] = await Promise.all([
      loadSubject(null),
      loadSubject(DEMO.member),
      loadSubject(DEMO.alice),
    ]);
    const [t] = await getWebDb()
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.forumId, 901),
          eq(threads.state, "visible"),
          eq(threads.authorId, DEMO.alice),
        ),
      )
      .limit(1);
    TID = t!.id;
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("游客与会员的阅读计入；刷入数据库后可见；同一访客窗口内只计一次", async () => {
    const before = await views();
    expect(await rec(guest)).toBe("counted");
    expect(await rec(member)).toBe("counted");
    expect(await rec(member)).toBe("deduped");
    await viewRuntime().counter.flush();
    expect(await views()).toBe(before + 2);
  });

  it("作者本人访问不计入", async () => {
    expect(await rec(alice, "198.51.100.1")).toBe("skipped");
  });

  it("并发：30 个互不相同的访客同时阅读，并发刷入两次，数据库增量恰好为 30", async () => {
    const before = await views();
    // 每个游客用不同的 IP，访客键各不相同，不会被去重吞掉
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => rec(guest, `192.0.2.${i + 1}`)),
    );
    expect(results.every((r) => r === "counted")).toBe(true);
    // 两个刷入并发执行：计数器每次取走当前增量，不得重复写入
    await Promise.all([viewRuntime().counter.flush(), viewRuntime().counter.flush()]);
    expect(await views()).toBe(before + 30);
  });

  it("隐藏的主题不计入（即使版主也不计）；恢复后再计", async () => {
    const before = await views();
    await getWebDb().update(threads).set({ state: "hidden" }).where(eq(threads.id, TID));
    try {
      const admin = await loadSubject(DEMO.admin);
      expect(await rec(admin, "198.51.100.2")).toBe("skipped");
      expect(await rec(guest, "198.51.100.3")).toBe("skipped");
    } finally {
      await getWebDb().update(threads).set({ state: "visible" }).where(eq(threads.id, TID));
    }
    expect(await rec(guest, "198.51.100.4")).toBe("counted");
    await viewRuntime().counter.flush();
    expect(await views()).toBe(before + 1);
  });

  it("写库只更新可见主题：待写入的增量遇到已隐藏的主题不生效", async () => {
    const before = await views();
    await rec(guest, "198.51.100.5");
    await getWebDb().update(threads).set({ state: "hidden" }).where(eq(threads.id, TID));
    try {
      await viewRuntime().counter.flush();
      expect(await views()).toBe(before);
    } finally {
      await getWebDb().update(threads).set({ state: "visible" }).where(eq(threads.id, TID));
    }
  });
});
