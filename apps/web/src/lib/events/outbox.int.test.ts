// @vitest-environment node
import { spawnSync } from "node:child_process";
import { eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eventLog, eventOutbox, getWebDb, getWebPool, moduleState } from "@funwind/db";
import { registerModule } from "@/modules/kernel/registry";
import {
  defineModule,
  MODERATION_NOTIFICATION_DELIVERY_POLICY,
  type EventDeliveryContext,
} from "@/modules/kernel/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  countPendingOutbox,
  dispatchOutboxRows,
  drainOutbox,
  enqueueEventInTx,
  sweepPending,
  type OutboxEmitter,
} from "./outbox";

const reviewDeliveries: (EventDeliveryContext | undefined)[] = [];
const reviewReason = "synthetic_review_reason_not_for_errors";

// 真实内核路径的消费者失败用例（P1 回归）：streak=666 的 checkin.done 让消费者抛错，
// 内核 emit 把它吞进 EmitResult.errors 而**不抛出**——outbox 必须识别并保持 pending
registerModule(
  defineModule({
    id: "test-flaky-consumer",
    description: "测试：对特定载荷抛错的消费者",
    events: {
      "checkin.done": (p) => {
        if (p.streak === 666) throw new Error("synthetic_checkin_consumer_failure");
      },
      "content.moderated": (payload, delivery) => {
        reviewDeliveries.push(delivery);
        if (reviewDeliveries.length === 1) {
          throw new Error(`派送失败: ${payload.reason}`, {
            cause: { sql: "synthetic_review_sql", params: [payload.reason] },
          });
        }
      },
    },
  }),
);

describe.skipIf(skipDb)("事务性 outbox", () => {
  let tdb: TempDb | undefined;

  beforeAll(async () => {
    tdb = await setupTempDb();
  });

  afterAll(async () => {
    await tdb?.teardown();
  });

  afterEach(async () => {
    await getWebDb().delete(eventOutbox);
    await getWebDb().delete(eventLog);
    reviewDeliveries.length = 0;
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
      if (fails?.(name, payload)) {
        throw new Error("synthetic_dispatch_message", { cause: { sql: "synthetic_dispatch_sql" } });
      }
      counts.set(keyOf(payload), (counts.get(keyOf(payload)) ?? 0) + 1);
      payloads.push({ name, payload });
    };
    return { emitter, counts, payloads };
  }

  const insert = (userId: number, streak: number, source = "posting") =>
    enqueueEventInTx(getWebDb(), "checkin.done", { userId, streak }, { actorId: userId, source });

  /** 在共享连接池的指定语句上注入一次错误，保留真实的 Drizzle 查询包装。 */
  function rejectQueryOnce(prefix: string, failure: Error) {
    const pool = getWebPool();
    const query = pool.query;
    const spy = vi.spyOn(pool, "query").mockImplementation((...args) => {
      const statement = typeof args[0] === "string" ? args[0] : args[0].sql;
      if (statement?.startsWith(prefix)) {
        spy.mockRestore();
        return Promise.reject(failure);
      }
      return Reflect.apply(query, pool, args);
    });
  }

  it("enqueue 校验事件名与必填载荷，非法写入期即抛", async () => {
    await expect(
      enqueueEventInTx(getWebDb(), "synthetic_unknown_event" as never, {} as never, {
        source: "x",
      }),
    ).rejects.toThrow(/^\[outbox\] 未注册的事件名$/);
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
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = collector((_n, p) => keyOf(p) === "999");
    await dispatchOutboxRows([row], { emitter: failing.emitter });
    expect(await countPendingOutbox()).toBe(1);
    const [broken] = await getWebDb()
      .select({ error: eventOutbox.dispatchError })
      .from(eventOutbox)
      .where(isNull(eventOutbox.dispatchedAt));
    const message = `dispatch_failed outboxId=${row.id} event=checkin.done`;
    expect(broken.error).toEqual({ message, attempts: 1, at: expect.any(String) });
    expect(errorLog.mock.calls).toEqual([
      [`[outbox] 派发失败（保持 pending，等待补派）: ${message}`],
    ]);

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

  it("审核理由保留在业务载荷，不进入错误摘要；快派与补派保留身份和来源", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = {
      postId: 7,
      operatorId: 90004,
      action: "reject",
      reason: reviewReason,
    } as const;
    const row = await enqueueEventInTx(getWebDb(), "content.moderated", payload, {
      source: "moderation",
      deliveryPolicy: MODERATION_NOTIFICATION_DELIVERY_POLICY,
    });
    await dispatchOutboxRows([row]);
    expect(await countPendingOutbox()).toBe(1);
    expect(await drainOutbox()).toEqual({ dispatched: 1, failed: 0, pendingLeft: 0 });
    const [stored] = await getWebDb().select().from(eventOutbox).where(eq(eventOutbox.id, row.id));
    const message = `consumer_failed outboxId=${row.id} event=content.moderated modules=test-flaky-consumer`;
    expect(stored.payload).toEqual(payload);
    expect(stored.dispatchError).toEqual({ message, at: expect.any(String), attempts: 1 });
    expect(errorLog.mock.calls).toEqual([
      [`[outbox] 派发失败（保持 pending，等待补派）: ${message}`],
    ]);
    const stable = {
      outboxId: row.id,
      originalSource: "moderation",
      deliveryPolicy: MODERATION_NOTIFICATION_DELIVERY_POLICY,
    };
    expect(reviewDeliveries).toEqual([stable, stable]);
    const logs = await getWebDb()
      .select()
      .from(eventLog)
      .where(eq(eventLog.eventName, "content.moderated"))
      .orderBy(eventLog.id);
    expect(logs.map((log) => log.source)).toEqual(["moderation", "outbox"]);
    expect(logs.map((log) => log.actorId)).toEqual([90004, 90004]);
    expect(logs.map((log) => log.payload)).toEqual([payload, payload]);
    expect(logs.map((log) => log.errorJson)).toEqual([
      JSON.stringify([{ moduleId: "test-flaky-consumer", message: "consumer_failed" }]),
      null,
    ]);
  });

  it("未知投递策略拒绝派发，不降级成不去重的历史处理", async () => {
    const row = await insert(90001, 5);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await getWebDb()
      .update(eventOutbox)
      .set({ deliveryPolicy: "synthetic_unknown_strategy" })
      .where(eq(eventOutbox.id, row.id));
    expect(await drainOutbox()).toEqual({ dispatched: 0, failed: 1, pendingLeft: 1 });
    expect(await getWebDb().select().from(eventLog)).toHaveLength(0);
    const [stored] = await getWebDb().select().from(eventOutbox).where(eq(eventOutbox.id, row.id));
    const message = `unsupported_delivery_policy outboxId=${row.id} event=checkin.done`;
    expect(stored.dispatchError).toEqual({ message, at: expect.any(String), attempts: 1 });
    expect(errorLog.mock.calls).toEqual([
      [`[outbox] 派发失败（保持 pending，等待补派）: ${message}`],
    ]);
  });

  it("状态读取失败时冷、热进程均保留 pending，恢复后按真实启停状态派发", async () => {
    // 独立模块实例保证冷启动不依赖测试执行顺序。
    vi.resetModules();
    const { dispatchOutboxRows: dispatch, drainOutbox: drain } = await import("./outbox");
    const { registerModule: register } = await import("@/modules/kernel/registry");
    const { getEnabledModuleIds } = await import("@/modules/kernel/state");
    const { emit } = await import("@/modules/kernel/bus");
    const moduleId = "test-state-consumer";
    const consume = vi.fn();
    register(defineModule({ id: moduleId, description: "", events: { "checkin.done": consume } }));

    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failStateRead = () =>
      rejectQueryOnce(
        "select `module_id`, `enabled`, `updated_at` from `module_state`",
        new Error("synthetic_module_state_error", { cause: { sql: "synthetic_module_state_sql" } }),
      );
    const coldLog = "[kernel] module_state_read_failed：没有可沿用的状态，所有模块暂按停用处理";
    const warmLog = "[kernel] module_state_read_failed：沿用上一次成功读到的启停状态";
    const outboxMessage = (id: number) => `dispatch_failed outboxId=${id} event=checkin.done`;
    const expectPending = async (id: number) => {
      const [stored] = await getWebDb().select().from(eventOutbox).where(eq(eventOutbox.id, id));
      expect(stored.dispatchedAt).toBeNull();
      expect(stored.dispatchError).toEqual({
        message: outboxMessage(id),
        at: expect.any(String),
        attempts: 1,
      });
    };
    const expectDispatched = async (id: number) => {
      const [stored] = await getWebDb().select().from(eventOutbox).where(eq(eventOutbox.id, id));
      expect(stored.dispatchedAt).not.toBeNull();
    };

    const cold = await insert(90001, 1);
    failStateRead();
    const writer = vi.fn();
    expect(await emit("checkin.done", { userId: 90001, streak: 1 }, { writer })).toEqual({
      dispatched: [],
      errors: [],
      logged: true,
    });
    expect(writer).toHaveBeenCalledOnce();
    failStateRead();
    await dispatch([cold]);
    await expectPending(cold.id);
    expect(consume).not.toHaveBeenCalled();
    expect(await getWebDb().select().from(eventLog)).toHaveLength(0);
    expect(await drain()).toEqual({ dispatched: 1, failed: 0, pendingLeft: 0 });
    await expectDispatched(cold.id);
    expect(consume).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenLastCalledWith(
      cold.payload,
      expect.objectContaining({ outboxId: cold.id }),
    );

    await getWebDb()
      .insert(moduleState)
      .values({ moduleId, enabled: false, updatedAt: "2026-11-19 00:00:00" });
    try {
      const disabled = await insert(90001, 2);
      await dispatch([disabled]);
      await expectDispatched(disabled.id);
      expect(consume).toHaveBeenCalledOnce();

      // 旧快照仍禁用，但管理员已经恢复启用；按旧快照完成会漏掉本轮消费者。
      await getWebDb()
        .update(moduleState)
        .set({ enabled: true })
        .where(eq(moduleState.moduleId, moduleId));
      failStateRead();
      expect((await getEnabledModuleIds()).has(moduleId)).toBe(false);
      const warm = await insert(90001, 3);
      failStateRead();
      expect(await drain()).toEqual({ dispatched: 0, failed: 1, pendingLeft: 1 });
      await expectPending(warm.id);
      expect(consume).toHaveBeenCalledOnce();
      expect(await drain()).toEqual({ dispatched: 1, failed: 0, pendingLeft: 0 });
      await expectDispatched(warm.id);
      expect(consume).toHaveBeenCalledTimes(2);
      expect(consume).toHaveBeenLastCalledWith(
        warm.payload,
        expect.objectContaining({ outboxId: warm.id }),
      );
      expect(errorLog.mock.calls).toEqual([
        [coldLog],
        [coldLog],
        [`[outbox] 派发失败（保持 pending，等待补派）: ${outboxMessage(cold.id)}`],
        [warmLog],
        [warmLog],
        [`[outbox] 派发失败（保持 pending，等待补派）: ${outboxMessage(warm.id)}`],
      ]);
    } finally {
      await getWebDb().delete(moduleState).where(eq(moduleState.moduleId, moduleId));
    }
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

  it("pending 里出现未知事件名：按稳定 ID 记错，不回显原值、不派发", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await getWebDb().insert(eventOutbox).values({
      eventName: "synthetic_unknown_event",
      payload: {},
      createdAt: "2026-10-25 12:00:00",
    });
    const c = collector();
    const summary = await drainOutbox({ emitter: c.emitter });
    expect(summary).toEqual({ dispatched: 0, failed: 1, pendingLeft: 1 });
    expect(c.payloads).toHaveLength(0);
    const [stored] = await getWebDb().select().from(eventOutbox);
    const message = `unknown_event outboxId=${stored.id}`;
    expect(stored.dispatchedAt).toBeNull();
    expect(stored.dispatchError).toEqual({ message, at: expect.any(String), attempts: 1 });
    expect(errorLog.mock.calls).toEqual([
      [`[outbox] 派发失败（保持 pending，等待补派）: ${message}`],
    ]);
  });

  it("真实内核路径：消费者抛错 → 行保持 pending（P1：emit 不抛错但 errors 非空）", async () => {
    const queued = await enqueueEventInTx(getWebDb(), "checkin.done", {
      userId: 90005,
      streak: 666,
    });
    // 默认 emit：消费者抛错被内核吞成 errors[]，outbox 必须识别并保持 pending
    const summary = await drainOutbox();
    expect(summary.dispatched).toBe(0);
    expect(summary.failed).toBe(1);
    expect(await countPendingOutbox()).toBe(1);
    const [row] = await getWebDb()
      .select({ error: eventOutbox.dispatchError })
      .from(eventOutbox)
      .where(isNull(eventOutbox.dispatchedAt));
    expect(row.error).toEqual({
      message: `consumer_failed outboxId=${queued.id} event=checkin.done modules=test-flaky-consumer`,
      at: expect.any(String),
      attempts: 1,
    });
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

  it("注入派发器返回非空 errors，仍保持 pending 但不采信其模块或消息", async () => {
    const row = await insert(90001, 42);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = await drainOutbox({
      emitter: async () => ({
        errors: [
          { moduleId: "synthetic_untrusted_module", message: "synthetic_untrusted_message" },
        ],
      }),
    });
    expect(summary).toEqual({ dispatched: 0, failed: 1, pendingLeft: 1 });
    const [stored] = await getWebDb().select().from(eventOutbox).where(eq(eventOutbox.id, row.id));
    const message = `consumer_failed outboxId=${row.id} event=checkin.done`;
    expect(stored.dispatchError).toEqual({ message, at: expect.any(String), attempts: 1 });
    expect(errorLog.mock.calls).toEqual([
      [`[outbox] 派发失败（保持 pending，等待补派）: ${message}`],
    ]);
  });

  it("标记失败保留重放，错误摘要写入失败也不反抛或打印 SQL", async () => {
    const row = await insert(90001, 42);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeFailure = new Error("synthetic_update_query", {
      cause: { sql: "synthetic_update_sql" },
    });
    rejectQueryOnce("update `event_outbox`", writeFailure);
    await expect(
      dispatchOutboxRows([row], { emitter: collector().emitter }),
    ).resolves.toBeUndefined();
    expect(await countPendingOutbox()).toBe(1);

    rejectQueryOnce("update `event_outbox`", writeFailure);
    const summary = await drainOutbox({
      emitter: async () => {
        throw "synthetic_dispatch_thrown_string";
      },
    });
    const context = `outboxId=${row.id} event=checkin.done`;
    expect(summary).toEqual({ dispatched: 0, failed: 1, pendingLeft: 1 });
    expect(errorLog.mock.calls).toEqual([
      [`[outbox] 快派成功但标记失败（将重放）: mark_dispatched_failed ${context}`],
      [`[outbox] 派发失败（保持 pending，等待补派）: dispatch_failed ${context}`],
      [`[outbox] 派发错误摘要写入失败: dispatch_error_write_failed ${context}`],
    ]);
    expect(await drainOutbox({ emitter: collector().emitter })).toEqual({
      dispatched: 1,
      failed: 0,
      pendingLeft: 0,
    });
  });

  it("event_log 落库失败只降级审计，不重试成功消费的 outbox 行", async () => {
    const row = await insert(90001, 42);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    rejectQueryOnce(
      "insert into `event_log`",
      new Error("synthetic_event_log_insert", { cause: { sql: "synthetic_event_log_sql" } }),
    );
    await dispatchOutboxRows([row]);
    expect(await countPendingOutbox()).toBe(0);
    const [stored] = await getWebDb().select().from(eventOutbox).where(eq(eventOutbox.id, row.id));
    expect(stored.dispatchedAt).not.toBeNull();
    expect(stored.dispatchError).toBeNull();
    expect(errorLog.mock.calls).toEqual([
      [
        "[kernel] event_log 落库失败（审计降级）",
        { category: "audit_write_failed", eventName: "checkin.done", outboxId: row.id },
      ],
    ]);
  });

  it("sweepPending 捎带后 pending 有界", async () => {
    await insert(90003, 1);
    await expect(sweepPending()).resolves.toBeUndefined();
    expect(await countPendingOutbox()).toBeLessThanOrEqual(10);
  });

  it("sweepPending 吞掉巡检查询异常，不输出查询或原因", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(getWebPool(), "query").mockRejectedValueOnce(
      new Error("synthetic_sweep_query", { cause: { sql: "synthetic_sweep_sql" } }),
    );
    await expect(sweepPending()).resolves.toBeUndefined();
    expect(errorLog.mock.calls).toEqual([["[outbox] 捎带巡检失败（不影响业务）: sweep_failed"]]);
  });

  it("补派脚本正常返回计数；连接不存在的隔离库时仅输出固定失败类别", async () => {
    const { name } = tdb!;
    const run = (dbName: string) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "./scripts/server-only-register.mjs",
          "--import",
          "tsx",
          "scripts/outbox-drain.ts",
        ],
        {
          cwd: new URL("../../../", import.meta.url),
          env: { ...process.env, NEW_DB_NAME: dbName },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
    await enqueueEventInTx(getWebDb(), "user.logged_in", { userId: 90001 });
    const success = run(name);
    expect(success.error).toBeUndefined();
    expect(success.stderr).toBe("");
    expect(success.status).toBe(0);
    expect(success.stdout).toContain("第 1 轮：补派 1，失败 0，剩余 pending 0");
    expect(await countPendingOutbox()).toBe(0);

    const missingDb = `${name}_synthetic_missing_db`;
    const failed = run(missingDb);
    expect(failed.error).toBeUndefined();
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr.trim()).toBe(
      "[outbox] 补派脚本失败: drain_run_failed（请检查模块或数据库状态）",
    );
  });
});
