// @vitest-environment node
/**
 * email.digest 任务的时刻闸门（M17 Step 1）：钉住两件事——
 * 1. 发送时刻按**北京墙面时间**比对，不是进程本地时区（旧脚本用 new Date().getHours()，
 *    容器 TZ=UTC 时后台配的「20 点」会错位成北京凌晨 4 点）；
 * 2. 每小时 cron + run 内闸门，保留后台可配时刻语义（固定每日 cron 会让该配置失效）。
 * 业务逻辑本身由 digest.int.test.ts 覆盖，这里只测闸门与结果映射，故 mock 掉服务层。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDigestHour = vi.hoisted(() => vi.fn(async () => 20));
const runDigestOnce = vi.hoisted(() =>
  vi.fn(async () => ({
    checked: 3,
    sent: 2,
    skippedActive: 1,
    skippedNoEmail: 0,
    skippedToday: 0,
    failed: 0,
  })),
);
const wallTime = vi.hoisted(() => vi.fn(() => "2026-11-13 20:00:00"));

vi.mock("@/lib/notifications/email", () => ({ getDigestHour }));
vi.mock("@/lib/notifications/digest", () => ({ runDigestOnce }));
vi.mock("@/lib/datetime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/datetime")>()),
  nowBeijingWallTime: wallTime,
}));

const { digestJob, DIGEST_JOB_KEY } = await import("./tasks");

beforeEach(() => {
  getDigestHour.mockClear().mockResolvedValue(20);
  runDigestOnce.mockClear().mockResolvedValue({
    checked: 3,
    sent: 2,
    skippedActive: 1,
    skippedNoEmail: 0,
    skippedToday: 0,
    failed: 0,
  });
  wallTime.mockClear().mockReturnValue("2026-11-13 20:00:00");
});

describe("email.digest 任务定义", () => {
  it("键稳定、每小时整点 cron（键同时是命名锁与日志标识）", () => {
    const job = digestJob();
    expect(job.key).toBe(DIGEST_JOB_KEY);
    expect(DIGEST_JOB_KEY).toBe("email.digest");
    expect(job.cron).toBe("0 * * * *");
  });
});

describe("时刻闸门按北京时间比对", () => {
  it("北京小时 == 配置时刻 → 执行并映射摘要", async () => {
    wallTime.mockReturnValue("2026-11-13 20:30:00"); // 北京 20 点
    const r = await digestJob().run();
    expect(runDigestOnce).toHaveBeenCalledTimes(1);
    expect(r.summary).toContain("sent=2");
    expect(r.summary).toContain("checked=3");
    expect(r.failed).toBe(0);
  });

  it("北京小时 != 配置时刻 → 空转，不调用服务层", async () => {
    wallTime.mockReturnValue("2026-11-13 04:00:00"); // 北京 4 点
    const r = await digestJob().run();
    expect(runDigestOnce).not.toHaveBeenCalled();
    expect(r.summary).toContain("skipped");
    expect(r.summary).toContain("配置 20 点");
  });

  it("同一 UTC 瞬间在不同进程时区下判定一致（时区无关性，用真实墙面函数而非 mock）", async () => {
    // 固定瞬间 UTC 2026-11-13 04:00 = 北京 12:00，配置 12 点 → 应执行。
    // 闸门若误用进程本地 getHours()，TZ=UTC 时判 4 点 ≠ 12 点而空转 → 红。
    // 墙面函数自身的 +08:00 正确性由 datetime.test.ts 锚定；这里钉「任务确实读北京墙面而非本地时区」。
    const { nowBeijingWallTime: realWall } =
      await vi.importActual<typeof import("@/lib/datetime")>("@/lib/datetime");
    wallTime.mockImplementation((atMs?: number) => realWall(atMs));
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 13, 4, 0, 0));
    getDigestHour.mockResolvedValue(12);
    const prev = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const r = await digestJob().run();
      expect(runDigestOnce).toHaveBeenCalledTimes(1);
      expect(r.summary).toContain("sent=2");
    } finally {
      clock.mockRestore();
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it("后台改时刻后立即生效（每次 run 都读配置，不缓存）", async () => {
    wallTime.mockReturnValue("2026-11-13 09:00:00");
    getDigestHour.mockResolvedValue(9);
    await digestJob().run();
    expect(runDigestOnce).toHaveBeenCalledTimes(1);
    getDigestHour.mockResolvedValue(20);
    runDigestOnce.mockClear();
    const r = await digestJob().run();
    expect(runDigestOnce).not.toHaveBeenCalled();
    expect(r.summary).toContain("skipped");
  });
});

describe("手动入口免闸门", () => {
  it("--user 指定用户：免时刻闸并透传 onlyUserId", async () => {
    wallTime.mockReturnValue("2026-11-13 04:00:00"); // 非配置时刻
    await digestJob({ onlyUserId: 90005 }).run();
    expect(runDigestOnce).toHaveBeenCalledWith({ onlyUserId: 90005, force: undefined });
  });

  it("--force：免时刻闸并透传 force（补发/测试）", async () => {
    wallTime.mockReturnValue("2026-11-13 04:00:00");
    await digestJob({ force: true }).run();
    expect(runDigestOnce).toHaveBeenCalledWith({ onlyUserId: undefined, force: true });
  });
});

describe("结果映射", () => {
  it("发送失败计入 failed，使任务状态记为 failed（不再静默）", async () => {
    runDigestOnce.mockResolvedValue({
      checked: 3,
      sent: 1,
      skippedActive: 0,
      skippedNoEmail: 0,
      skippedToday: 0,
      failed: 2,
    });
    const r = await digestJob().run();
    expect(r.failed).toBe(2);
    expect(r.summary).toContain("failed=2");
  });

  it("当日幂等跳过数进摘要（便于运维看出闸在生效）", async () => {
    runDigestOnce.mockResolvedValue({
      checked: 3,
      sent: 0,
      skippedActive: 0,
      skippedNoEmail: 0,
      skippedToday: 3,
      failed: 0,
    });
    const r = await digestJob().run();
    expect(r.summary).toContain("skippedToday=3");
    expect(r.failed).toBe(0);
  });
});
