// @vitest-environment node
import { eq, isNull } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eventLog, eventOutbox, getWebDb } from "@funwind/db";
import { registerModule } from "@/modules/kernel/registry";
import { defineModule } from "@/modules/kernel/types";
import { setupTempDb, skipDb } from "@/test/temp-db";
import {
  countPendingOutbox,
  dispatchOutboxRows,
  drainOutbox,
  enqueueEventInTx,
  sweepPending,
  type OutboxEmitter,
} from "./outbox";

// 真实内核路径的消费者失败用例（P1 回归）：streak=666 的 checkin.done 让消费者抛错，
// 内核 emit 把它吞进 EmitResult.errors 而**不抛出**——outbox 必须识别并保持 pending
registerModule(
  defineModule({
    id: "test-flaky-consumer",
    description: "测试：对特定载荷抛错的消费者",
    events: {
      "checkin.done": (p) => {
        if (p.streak === 666) throw new Error("消费者炸了（测试注入）");
      },
    },
  }),
);

describe.skipIf(skipDb)("事务性 outbox", () => {
  beforeAll(async () => {
    await setupTempDb();
  });

  afterEach(async () => {
    await getWebDb().delete(eventOutbox);
    await getWebDb().delete(eventLog);
    vi.restoreAllMocks();
  });

  /** 载荷唯一键（本文件用 streak 区分行）；按它计数派发次数 */
  const keyOf = (payload: unknown): string =>
    JSON.stringify((payload as { streak?: number }).streak);

  /** 收集派发；fails 命中的载荷抛错（模拟派发失败） */
  function collector(fails?: (name: string, payload: unknown) => boolean) {
    const counts = new Map<string, number>();
    const payloads: { name: string; payload: unknown }[] = [];
    const emitter: OutboxEmitter = async (name, payload) => {
      if (fails?.(name, payload)) throw new Error("注入失败");
      counts.set(keyOf(payload), (counts.get(keyOf(payload)) ?? 0) + 1);
      payloads.push({ name, payload });
    };
    return { emitter, counts, payloads };
  }

  const insert = (userId: number, streak: number, source = "posting") =>
    enqueueEventInTx(getWebDb(), "checkin.done", { userId, streak }, { actorId: userId, source });

  it("enqueue 校验事件名与必填载荷，非法写入期即抛", async () => {
    await expect(
      enqueueEventInTx(getWebDb(), "not.an.event" as never, {} as never, { source: "x" }),
    ).rejects.toThrow(/未注册的事件名/);
    await expect(
      // thread.created 缺 title
      enqueueEventInTx(getWebDb(), "thread.created", {
        threadId: 1,
        postId: 1,
        forumId: 1,
        authorId: 1,
        title: undefined,
      } as never),
    ).rejects.toThrow(/载荷非法/);
    expect(await countPendingOutbox()).toBe(0);
  });

  it("快路径：派发成功即标记 dispatched，event_log 沿用入队来源", async () => {
    const row = await insert(90001, 3);
    await dispatchOutboxRows([row]);
    const [stored] = await getWebDb().select().from(eventOutbox).where(eq(eventOutbox.id, row.id));
    expect(stored.dispatchedAt).not.toBeNull();
    expect(await countPendingOutbox()).toBe(0);
    const [log] = await getWebDb()
      .select()
      .from(eventLog)
      .where(eq(eventLog.eventName, "checkin.done"));
    expect(log.source).toBe("posting");
    expect(log.actorId).toBe(90001);
  });

  it("派发失败：保持 pending、记录错误摘要；drain 补派成功后标记且 source=outbox", async () => {
    const row = await insert(90001, 999);
    const failing = collector((_n, p) => keyOf(p) === "999");
    await dispatchOutboxRows([row], { emitter: failing.emitter });
    expect(await countPendingOutbox()).toBe(1);
    const [broken] = await getWebDb()
      .select({ error: eventOutbox.dispatchError })
      .from(eventOutbox)
      .where(isNull(eventOutbox.dispatchedAt));
    expect(broken.error).toMatchObject({ message: "注入失败" });

    const working = collector();
    const summary = await drainOutbox({ emitter: working.emitter });
    expect(summary.dispatched).toBe(1);
    expect(summary.pendingLeft).toBe(0);
    expect(await countPendingOutbox()).toBe(0);
    // 再补一行并走默认派发路径（真实 emit）：补派写 event_log 的 source 是 "outbox"（与首次派发区分）
    await insert(90004, 5);
    await drainOutbox();
    const logs = await getWebDb()
      .select()
      .from(eventLog)
      .where(eq(eventLog.eventName, "checkin.done"));
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe("outbox");
  });

  it("补派载荷与首次一致（at-least-once，消费端幂等吸收）", async () => {
    await insert(90002, 7);
    const seen: unknown[] = [];
    // 第一次补派失败（错误记录），第二次成功——两次收到的载荷逐字相同
    await drainOutbox({
      emitter: async (_n, p) => {
        seen.push(structuredClone(p));
        throw new Error("no");
      },
    });
    await drainOutbox({ emitter: async (_n, p) => void seen.push(structuredClone(p)) });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[1]).toEqual({ userId: 90002, streak: 7 });
  });

  it("并发 drain 不丢行：每行至少派发一次、重复有界、最终全部标记", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push((await insert(90001, i + 1)).id);
    const c = collector();
    // 两路并发巡检：可能重复派发同一行（无互斥），消费端幂等吸收
    const [a, b] = await Promise.all([
      drainOutbox({ emitter: c.emitter }),
      drainOutbox({ emitter: c.emitter }),
    ]);
    expect(a.pendingLeft).toBe(0);
    expect(b.pendingLeft).toBe(0);
    for (let i = 0; i < 8; i++) {
      const n = c.counts.get(String(i + 1)) ?? 0;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(2);
    }
    expect(c.payloads.length).toBeGreaterThanOrEqual(8);
    expect(c.payloads.length).toBeLessThanOrEqual(16);
    expect(await countPendingOutbox()).toBe(0);
    void ids;
  });

  it("pending 里出现未知事件名：记错误、不标记、不算成功", async () => {
    await getWebDb().insert(eventOutbox).values({
      eventName: "made.up.event",
      payload: {},
      createdAt: "2026-10-25 12:00:00",
    });
    const c = collector();
    const summary = await drainOutbox({ emitter: c.emitter });
    expect(summary.dispatched).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.pendingLeft).toBe(1);
    expect(c.payloads).toHaveLength(0);
  });

  it("真实内核路径：消费者抛错 → 行保持 pending（P1：emit 不抛错但 errors 非空）", async () => {
    await enqueueEventInTx(getWebDb(), "checkin.done", { userId: 90005, streak: 666 });
    // 默认 emit：消费者抛错被内核吞成 errors[]，outbox 必须识别并保持 pending
    const summary = await drainOutbox();
    expect(summary.dispatched).toBe(0);
    expect(summary.failed).toBe(1);
    expect(await countPendingOutbox()).toBe(1);
    const [row] = await getWebDb()
      .select({ error: eventOutbox.dispatchError })
      .from(eventOutbox)
      .where(isNull(eventOutbox.dispatchedAt));
    expect(row.error).toMatchObject({ message: /消费者失败.*消费者炸了/ });
  });

  it("毒行退避：重复失败（第 2 次起）10 分钟内跳过，批内其它行不受队头阻塞", async () => {
    // 毒行（666，真实消费者会抛错）比健康行（42）更老——id ASC 下它占批首
    await enqueueEventInTx(getWebDb(), "checkin.done", { userId: 90005, streak: 666 });
    await enqueueEventInTx(getWebDb(), "checkin.done", { userId: 90005, streak: 42 });

    // 第 1 轮：毒行首次失败（attempts=1），健康行照常派发——首次失败不退避，队头不阻塞
    const r1 = await drainOutbox();
    expect(r1.dispatched).toBe(1);
    expect(r1.failed).toBe(1);
    expect(await countPendingOutbox()).toBe(1);

    // 第 2 轮：毒行被立即重试（首次失败不退避），再次失败 → attempts=2
    const r2 = await drainOutbox();
    expect(r2.dispatched).toBe(0);
    expect(r2.failed).toBe(1);

    // 第 3 轮：attempts≥2 且 10 分钟内失败过 → 退避跳过，不再刷错误
    const r3 = await drainOutbox();
    expect(r3.dispatched).toBe(0);
    expect(r3.failed).toBe(0);
    expect(r3.pendingLeft).toBe(1);
    expect(await countPendingOutbox()).toBe(1);
  });

  it("sweepPending 吞错不反噬业务；捎带后 pending 有界", async () => {
    await insert(90003, 1);
    await expect(sweepPending()).resolves.toBeUndefined();
    expect(await countPendingOutbox()).toBeLessThanOrEqual(10);
  });
});
