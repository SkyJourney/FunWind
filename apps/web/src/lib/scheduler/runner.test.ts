// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LockHandle, LockProvider } from "./lock";
import { runJob, type JobDef, type JobResult, type Logger } from "./runner";

/** 任务执行器：抢锁 → 执行 → 记日志 → 释放锁。重点守「永不抛」与「锁在任务结束前不释放」 */

function fakeLocks(
  options: { acquired?: boolean; acquireThrows?: Error; releaseThrows?: Error } = {},
) {
  const release = vi.fn(async () => {
    if (options.releaseThrows) throw options.releaseThrows;
  });
  const handle: LockHandle = { release };
  const tryAcquire = vi.fn(async (_key: string) => {
    if (options.acquireThrows) throw options.acquireThrows;
    return options.acquired === false ? null : handle;
  });
  return { locks: { tryAcquire } satisfies LockProvider, release, tryAcquire };
}

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

const job = (run: () => Promise<JobResult>, timeoutMs = 60_000): JobDef => ({
  key: "test.job",
  cron: "* * * * *",
  timeoutMs,
  run,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("runJob", () => {
  it("正常路径：按任务键抢锁、执行、释放，状态 ok 并带上任务摘要", async () => {
    const { locks, release, tryAcquire } = fakeLocks();
    const log = fakeLog();
    const outcome = await runJob(
      job(async () => ({ summary: "checked=1" })),
      { locks, log },
    );
    expect(tryAcquire).toHaveBeenCalledExactlyOnceWith("test.job");
    expect(outcome).toMatchObject({ status: "ok", summary: "checked=1" });
    expect(release).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("job=test.job status=ok"));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("checked=1"));
  });

  it("没抢到锁（别的实例在跑）：不执行任务、不释放（本就没持有）、状态 skipped", async () => {
    const { locks, release } = fakeLocks({ acquired: false });
    const run = vi.fn(async () => ({ summary: "x" }));
    const log = fakeLog();
    const outcome = await runJob(job(run), { locks, log });
    expect(outcome).toEqual({ status: "skipped", durationMs: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("status=skipped"));
  });

  it("任务抛异常：不外抛、状态 failed、锁照常释放、日志只含名称和消息不含堆栈", async () => {
    const { locks, release } = fakeLocks();
    const log = fakeLog();
    const error = new TypeError("boom");
    const outcome = await runJob(
      job(async () => Promise.reject(error)),
      { locks, log },
    );
    expect(outcome).toMatchObject({ status: "failed", summary: "TypeError: boom" });
    expect(release).toHaveBeenCalledOnce();
    const logged = log.error.mock.calls.map((c) => c[0]).join("\n");
    expect(logged).toContain("TypeError: boom");
    expect(logged).not.toContain("at ");
  });

  it("任务抛出非 Error 值也不外抛，日志写「未知错误」而不是把值原样打出来", async () => {
    const { locks } = fakeLocks();
    const log = fakeLog();
    const outcome = await runJob(
      job(async () => Promise.reject("secret-token-123")),
      { locks, log },
    );
    expect(outcome).toMatchObject({ status: "failed", summary: "未知错误" });
    expect(log.error.mock.calls.flat().join("")).not.toContain("secret-token-123");
  });

  it("任务返回 failed > 0（部分失败）：状态 failed，按 error 级别记日志", async () => {
    const { locks } = fakeLocks();
    const log = fakeLog();
    const outcome = await runJob(
      job(async () => ({ summary: "checked=3 failed=1", failed: 1 })),
      {
        locks,
        log,
      },
    );
    expect(outcome.status).toBe("failed");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("checked=3 failed=1"));
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("status=failed"));
  });

  it("抢锁时数据库不可用：不外抛、状态 failed，任务不执行", async () => {
    const { locks } = fakeLocks({ acquireThrows: new Error("ECONNREFUSED") });
    const run = vi.fn(async () => ({ summary: "x" }));
    const log = fakeLog();
    const outcome = await runJob(job(run), { locks, log });
    expect(outcome.status).toBe("failed");
    expect(run).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("释放锁时出错：不外抛，任务结果不受影响", async () => {
    const { locks } = fakeLocks({ releaseThrows: new Error("release failed") });
    const log = fakeLog();
    const outcome = await runJob(
      job(async () => ({ summary: "ok" })),
      { locks, log },
    );
    expect(outcome.status).toBe("ok");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("release failed"));
  });

  it("超时只记警告，锁保持到任务真正结束才释放（否则别的实例会并发执行同一任务）", async () => {
    const { locks, release } = fakeLocks();
    const log = fakeLog();
    let finish!: (r: JobResult) => void;
    const slow = new Promise<JobResult>((resolve) => (finish = resolve));
    const running = runJob(
      job(() => slow, 1_000),
      { locks, log },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("job=test.job"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("锁保持到任务结束"));
    expect(release, "超时时任务还在跑，不能释放锁").not.toHaveBeenCalled();

    finish({ summary: "late" });
    const outcome = await running;
    expect(outcome.status).toBe("ok");
    expect(release).toHaveBeenCalledOnce();
  });

  it("任务在超时之前结束：不产生超时警告，且定时器被清掉", async () => {
    const { locks } = fakeLocks();
    const log = fakeLog();
    await runJob(
      job(async () => ({ summary: "fast" }), 1_000),
      { locks, log },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("耗时用注入的时钟计算", async () => {
    const { locks } = fakeLocks();
    const log = fakeLog();
    const clock = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_750);
    const outcome = await runJob(
      job(async () => ({ summary: "t" })),
      { locks, log, now: clock },
    );
    expect(outcome).toMatchObject({ status: "ok", durationMs: 750 });
  });
});
