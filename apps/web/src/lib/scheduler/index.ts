import "server-only";

import { Cron } from "croner";
import { defaultJobs } from "./jobs";
import { createMysqlLocks, type LockProvider } from "./lock";
import { consoleLogger, runJob, type JobDef, type Logger } from "./runner";

/**
 * 进程内定时任务调度器（M11.5，设计见 docs/milestones/M11.5-scheduler.md）。
 *
 * 由 src/instrumentation.ts 在服务实例启动时调用一次，**只登记定时器、立即返回**——Next 要求 register()
 * 在服务就绪前返回，不能 await 任务运行。
 *  - 默认关闭，必须显式 SCHEDULER=on：开发库连的是真实 SMTP，E2E 的生产构建也是 next start，
 *    按 NODE_ENV 自动开启会让定时任务踩到正在测试的数据；
 *  - 一律按北京时间解释表达式（库内时间是北京墙面时间的硬约定）；
 *  - protect：同一进程内上一轮没结束就跳过本轮；跨实例靠 MySQL 命名锁（见 lock.ts）；
 *  - unref：定时器不阻止进程退出；
 *  - globalThis 守卫：next dev 热更新或重复调用不会重复登记。
 */

export const SCHEDULER_TIMEZONE = "Asia/Shanghai";

/** croner 里本模块用到的那一小部分接口，便于单测注入假实现 */
export interface CronLike {
  stop(): void;
}
export type CronFactory = (
  pattern: string,
  options: {
    name: string;
    timezone: string;
    protect: boolean;
    unref: boolean;
    catch: (error: unknown) => void;
  },
  handler: () => Promise<void>,
) => CronLike;

const realCron: CronFactory = (pattern, options, handler) => new Cron(pattern, options, handler);

export interface SchedulerHandle {
  jobKeys: string[];
  stop(): void;
}

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  jobs?: readonly JobDef[];
  cron?: CronFactory;
  locks?: LockProvider;
  log?: Logger;
  now?: () => number;
}

const g = globalThis as unknown as { __fwScheduler?: SchedulerHandle };

/** 是否启用：只认精确的 on，其余（含 ON、1、true）一律不启动，避免模糊值误开 */
export function schedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SCHEDULER === "on";
}

export function startScheduler(options: StartOptions = {}): SchedulerHandle | null {
  if (!schedulerEnabled(options.env)) return null;
  if (g.__fwScheduler) return g.__fwScheduler;

  const log = options.log ?? consoleLogger;
  const jobs = options.jobs ?? defaultJobs();
  const createCron = options.cron ?? realCron;
  const locks = options.locks ?? createMysqlLocks();

  const crons = jobs.map((job) =>
    createCron(
      job.cron,
      {
        name: job.key,
        timezone: SCHEDULER_TIMEZONE,
        protect: true,
        unref: true,
        // runJob 按契约不抛；这里是最后一道兜底，防止任何漏网异常变成进程级未处理 rejection
        catch: (error) =>
          log.error(
            `job=${job.key} 未捕获异常：${error instanceof Error ? `${error.name}: ${error.message}` : "未知错误"}`,
          ),
      },
      // 返回 Promise：croner 的 protect 靠它判断上一轮是否结束
      async () => {
        await runJob(job, { locks, log, now: options.now });
      },
    ),
  );

  const handle: SchedulerHandle = {
    jobKeys: jobs.map((job) => job.key),
    stop() {
      for (const cron of crons) cron.stop();
      if (g.__fwScheduler === handle) delete g.__fwScheduler;
    },
  };
  g.__fwScheduler = handle;
  log.info(
    `已登记 ${jobs.length} 个任务：${handle.jobKeys.join("、")}（时区 ${SCHEDULER_TIMEZONE}）`,
  );
  return handle;
}

/** 停止并清除全局登记（测试与优雅退出用） */
export function stopScheduler(): void {
  g.__fwScheduler?.stop();
}
