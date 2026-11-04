import "server-only";

import type { LockProvider } from "./lock";

/**
 * 任务执行器（M11.5）：抢锁 → 执行 → 记日志 → 释放锁。
 *
 * 三条约束，每条都有测试钉住：
 *  1. **永不抛**：定时器回调里抛出的异常会变成未处理的 rejection；任何失败（抢锁、任务本身、释放）都只记日志。
 *  2. **锁在任务真正结束之前不释放，包括超时之后**。超时时任务其实还在跑，这时释放锁，别的实例就会抢到同一把锁
 *     并发执行同一个任务，互斥就失效了。所以超时只记一条警告，锁保持到任务自己结束。
 *  3. 日志只记任务键、状态、耗时与任务返回的摘要；异常只记名称和消息，不记堆栈与参数，避免把凭据或个人信息写进日志。
 */

/** 任务返回的结果：summary 写进日志；failed > 0 表示部分失败，状态记为 failed */
export interface JobResult {
  summary: string;
  failed?: number;
}

export interface JobDef {
  /** 任务键：同时是命名锁的键与日志里的标识，不要改名 */
  key: string;
  /** 5 或 6 段 cron 表达式（6 段首位为秒），按北京时间解释 */
  cron: string;
  /** 超过这个时间仍未结束就记警告（不会强杀，也不会提前释放锁） */
  timeoutMs: number;
  run(): Promise<JobResult>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RunnerDeps {
  locks: LockProvider;
  log: Logger;
  /** 可注入的时钟，单测用 */
  now?: () => number;
}

export type RunOutcome =
  | { status: "ok"; durationMs: number; summary: string }
  | { status: "skipped"; durationMs: 0 }
  | { status: "failed"; durationMs: number; summary: string };

/** 控制台日志；前缀统一便于检索 */
export const consoleLogger: Logger = {
  info: (message) => console.log(`[scheduler] ${message}`),
  warn: (message) => console.warn(`[scheduler] ${message}`),
  error: (message) => console.error(`[scheduler] ${message}`),
};

/** 异常只取名称与消息 */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "未知错误";
}

export async function runJob(job: JobDef, deps: RunnerDeps): Promise<RunOutcome> {
  const now = deps.now ?? Date.now;
  let handle;
  try {
    handle = await deps.locks.tryAcquire(job.key);
  } catch (error) {
    deps.log.error(`job=${job.key} status=failed 抢锁失败：${describeError(error)}`);
    return { status: "failed", durationMs: 0, summary: "抢锁失败" };
  }
  if (!handle) {
    deps.log.info(`job=${job.key} status=skipped 其他实例正在运行`);
    return { status: "skipped", durationMs: 0 };
  }

  const startedAt = now();
  // 超时只提醒：任务还在跑，锁必须保持到它结束
  const timer = setTimeout(() => {
    deps.log.warn(
      `job=${job.key} 已运行超过 ${Math.round(job.timeoutMs / 1000)} 秒仍未结束，锁保持到任务结束`,
    );
  }, job.timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  let outcome: RunOutcome;
  try {
    const result = await job.run();
    const durationMs = now() - startedAt;
    const failed = (result.failed ?? 0) > 0;
    outcome = failed
      ? { status: "failed", durationMs, summary: result.summary }
      : { status: "ok", durationMs, summary: result.summary };
    (failed ? deps.log.error : deps.log.info)(
      `job=${job.key} status=${outcome.status} durationMs=${durationMs} ${result.summary}`,
    );
  } catch (error) {
    const durationMs = now() - startedAt;
    const summary = describeError(error);
    outcome = { status: "failed", durationMs, summary };
    deps.log.error(`job=${job.key} status=failed durationMs=${durationMs} ${summary}`);
  } finally {
    clearTimeout(timer);
    try {
      await handle.release();
    } catch (error) {
      // release 按契约不抛；万一实现违约，也不能让它逃出去
      deps.log.error(`job=${job.key} 释放锁失败：${describeError(error)}`);
    }
  }
  return outcome;
}
