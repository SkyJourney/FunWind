// @vitest-environment node
import { Cron } from "croner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lockNameOf } from "./lock";
import type { JobDef, Logger } from "./runner";
import {
  SCHEDULER_TIMEZONE,
  schedulerEnabled,
  startScheduler,
  stopScheduler,
  type CronFactory,
} from "./index";

// 只替换会碰数据库与模块内核的两个边界；调度逻辑与 croner 的表达式解析用真实代码
vi.mock("@/modules", () => ({}));
vi.mock("@funwind/db", () => ({ getWebPool: vi.fn() }));
vi.mock("@/lib/auth/account-deletion", () => ({ processDueAccountDeletions: vi.fn() }));
vi.mock("@/lib/auth/unverified-cleanup", () => ({
  DEFAULT_UNVERIFIED_TTL_DAYS: 7,
  purgeOverdueUnverifiedAccounts: vi.fn(),
}));

import { defaultJobs } from "./jobs";

/** 测试用环境变量：Next 的类型把 NODE_ENV 声明为必填，统一在这里补齐 */
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  ...extra,
});
const ON = env({ SCHEDULER: "on" });
const log = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** 假 cron：记录登记参数，测试里手动触发 */
function fakeCron() {
  const registered: {
    pattern: string;
    options: Parameters<CronFactory>[1];
    handler: () => Promise<void>;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const factory: CronFactory = (pattern, options, handler) => {
    const stop = vi.fn();
    registered.push({ pattern, options, handler, stop });
    return { stop };
  };
  return { factory, registered };
}

const jobs: JobDef[] = [
  {
    key: "a.job",
    cron: "*/15 * * * *",
    timeoutMs: 1000,
    run: vi.fn(async () => ({ summary: "a" })),
  },
  { key: "b.job", cron: "30 3 * * *", timeoutMs: 1000, run: vi.fn(async () => ({ summary: "b" })) },
];

const locks = { tryAcquire: vi.fn(async () => ({ release: vi.fn(async () => {}) })) };

beforeEach(() => vi.clearAllMocks());
afterEach(() => stopScheduler());

describe("schedulerEnabled：只认精确的 on", () => {
  it.each([
    [{ SCHEDULER: "on" }, true],
    [{ SCHEDULER: "ON" }, false],
    [{ SCHEDULER: "1" }, false],
    [{ SCHEDULER: "true" }, false],
    [{ SCHEDULER: "" }, false],
    [{}, false],
  ] as const)("%j → %s", (e, expected) => {
    expect(schedulerEnabled(env(e))).toBe(expected);
  });
});

describe("startScheduler", () => {
  it("未启用时什么都不登记，返回 null", () => {
    const { factory, registered } = fakeCron();
    expect(startScheduler({ env: env(), jobs, cron: factory, locks, log: log() })).toBeNull();
    expect(registered).toHaveLength(0);
  });

  it("启用时每个任务登记一次，选项固定：北京时间、过载保护、unref、任务键作名字", () => {
    const { factory, registered } = fakeCron();
    const l = log();
    const handle = startScheduler({ env: ON, jobs, cron: factory, locks, log: l });
    expect(handle?.jobKeys).toEqual(["a.job", "b.job"]);
    expect(registered.map((r) => r.pattern)).toEqual(["*/15 * * * *", "30 3 * * *"]);
    for (const r of registered) {
      expect(r.options).toMatchObject({ timezone: "Asia/Shanghai", protect: true, unref: true });
    }
    expect(registered.map((r) => r.options.name)).toEqual(["a.job", "b.job"]);
    expect(SCHEDULER_TIMEZONE).toBe("Asia/Shanghai");
    expect(l.info).toHaveBeenCalledWith(expect.stringContaining("已登记 2 个任务"));
  });

  it("重复调用（热更新 / 重复登记）只登记一次，返回同一个句柄", () => {
    const { factory, registered } = fakeCron();
    const first = startScheduler({ env: ON, jobs, cron: factory, locks, log: log() });
    const second = startScheduler({ env: ON, jobs, cron: factory, locks, log: log() });
    expect(second).toBe(first);
    expect(registered).toHaveLength(2);
  });

  it("到点触发 = 抢锁并执行对应任务", async () => {
    const { factory, registered } = fakeCron();
    startScheduler({ env: ON, jobs, cron: factory, locks, log: log() });
    await registered[1]!.handler();
    expect(locks.tryAcquire).toHaveBeenCalledExactlyOnceWith("b.job");
    expect(jobs[1]!.run).toHaveBeenCalledOnce();
    expect(jobs[0]!.run).not.toHaveBeenCalled();
  });

  it("任务失败不会让触发回调抛出（否则变成进程级未处理 rejection）", async () => {
    const { factory, registered } = fakeCron();
    const boom: JobDef = {
      key: "boom",
      cron: "* * * * *",
      timeoutMs: 1000,
      run: async () => Promise.reject(new Error("x")),
    };
    startScheduler({ env: ON, jobs: [boom], cron: factory, locks, log: log() });
    await expect(registered[0]!.handler()).resolves.toBeUndefined();
  });

  it("触发回调要等到任务结束才 resolve：croner 的 protect 靠它判断上一轮是否还在跑，提前返回会让同进程叠跑同一任务", async () => {
    const { factory, registered } = fakeCron();
    let finish!: () => void;
    const slow: JobDef = {
      key: "slow",
      cron: "* * * * *",
      timeoutMs: 60_000,
      run: () => new Promise((resolve) => (finish = () => resolve({ summary: "done" }))),
    };
    startScheduler({ env: ON, jobs: [slow], cron: factory, locks, log: log() });

    let settled = false;
    const pending = registered[0]!.handler().then(() => (settled = true));
    // 让抢锁与任务启动的微任务都跑完；任务还没结束，回调必须仍是 pending
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled, "任务未结束时回调不能返回").toBe(false);

    finish();
    await pending;
    expect(settled).toBe(true);
  });

  it("兜底的 catch 回调只记日志，不外抛", () => {
    const { factory, registered } = fakeCron();
    const l = log();
    startScheduler({ env: ON, jobs: [jobs[0]!], cron: factory, locks, log: l });
    expect(() => registered[0]!.options.catch(new Error("leak"))).not.toThrow();
    expect(l.error).toHaveBeenCalledWith(expect.stringContaining("leak"));
  });

  it("stop() 停掉全部定时器并清掉全局登记，之后可以重新启动", () => {
    const { factory, registered } = fakeCron();
    const handle = startScheduler({ env: ON, jobs, cron: factory, locks, log: log() })!;
    handle.stop();
    expect(registered.every((r) => r.stop.mock.calls.length === 1)).toBe(true);
    const again = startScheduler({ env: ON, jobs, cron: factory, locks, log: log() });
    expect(again).not.toBe(handle);
    expect(registered).toHaveLength(4);
  });
});

describe("任务清单自检（用真实 croner 解析表达式）", () => {
  const list = defaultJobs();

  it("首批三个任务，键唯一且稳定（键同时是命名锁与日志标识，不能改名）", () => {
    expect(list.map((j) => j.key)).toEqual([
      "account-deletion.drain",
      "unverified-accounts.purge",
      "ops.alerts",
    ]);
    expect(new Set(list.map((j) => j.key)).size).toBe(list.length);
  });

  it.each(defaultJobs().map((j) => [j.key, j] as const))(
    "%s 的 cron 表达式合法，且按北京时间触发",
    (_key, job) => {
      const cron = new Cron(job.cron, { timezone: SCHEDULER_TIMEZONE, paused: true });
      const next = cron.nextRun();
      expect(next).toBeInstanceOf(Date);
      cron.stop();
    },
  );

  it("账号注销每 15 分钟、超期清理每天 03:30（站长在 M11.5 设计稿确认）", () => {
    const byKey = Object.fromEntries(list.map((j) => [j.key, j.cron]));
    expect(byKey["account-deletion.drain"]).toBe("*/15 * * * *");
    expect(byKey["unverified-accounts.purge"]).toBe("30 3 * * *");
  });

  it("超期清理在 03:30（北京时间）触发，而不是 UTC 的 03:30", () => {
    const job = list.find((j) => j.key === "unverified-accounts.purge")!;
    const cron = new Cron(job.cron, { timezone: SCHEDULER_TIMEZONE, paused: true });
    const next = cron.nextRun()!;
    // 北京时间 03:30 = UTC 19:30（前一天）
    expect(next.getUTCHours()).toBe(19);
    expect(next.getUTCMinutes()).toBe(30);
    cron.stop();
  });

  it("每个任务的命名锁名都不超过 MySQL 的 64 字符上限", () => {
    for (const job of list) {
      expect(lockNameOf("qysub_next_e2e", job.key).length).toBeLessThanOrEqual(64);
    }
  });

  it("超时设置合理：注销 5 分钟、清理 10 分钟", () => {
    const byKey = Object.fromEntries(list.map((j) => [j.key, j.timeoutMs]));
    expect(byKey["account-deletion.drain"]).toBe(5 * 60_000);
    expect(byKey["unverified-accounts.purge"]).toBe(10 * 60_000);
  });
});

describe("lockNameOf", () => {
  it("带库名：同一台 MySQL 上不同库的同一任务不会互相抢锁", () => {
    expect(lockNameOf("db_a", "job")).not.toBe(lockNameOf("db_b", "job"));
    expect(lockNameOf("db_a", "job")).toBe("fw:db_a:job");
  });

  it("超长时改用哈希：确定、不超限、不同输入不同结果", () => {
    const long = "x".repeat(80);
    const a = lockNameOf("db", long);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(lockNameOf("db", long)).toBe(a);
    expect(lockNameOf("db2", long)).not.toBe(a);
    expect(a.startsWith("fw:h:")).toBe(true);
  });

  it("恰好 64 字符不触发哈希", () => {
    const key = "k".repeat(64 - "fw:db:".length);
    const name = lockNameOf("db", key);
    expect(name.length).toBe(64);
    expect(name).toBe(`fw:db:${key}`);
  });
});
