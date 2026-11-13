// @vitest-environment node
/**
 * S7 每日汇总脚本（scripts/digest-cron.mts）· 真起子进程的集成测试（M17 Step 1）。
 *
 * 脚本本步从「直调 runDigestOnce」改为「走 runJob + 共用命名锁」，进程级行为必须实测：
 * 参数解析、退出码、干完活会不会自行退出（getWebDb 连接池占着事件循环，只设 exitCode 会留僵尸进程），
 * 以及与进程内调度器互斥。时刻闸门本身由 digest-job.test.ts 覆盖，这里只验它在真进程里生效。
 */
import { sql } from "drizzle-orm";
import { getWebDb } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMysqlLocks } from "@/lib/scheduler/lock";
import { DIGEST_JOB_KEY } from "@/lib/scheduler/tasks";
import { nowBeijingWallTime } from "@/lib/datetime";
import { runWebScript } from "@/test/script-runner";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";

const runScript = (dbName: string, args: string[] = []) =>
  runWebScript(dbName, "digest-cron.mts", args);

let tdb: TempDb;
const db = () => getWebDb();
const beijingHour = () => Number(nowBeijingWallTime().slice(11, 13));

/** 直接 upsert 站点配置（避开对列名的猜测，与 E2E 里同款写法） */
const setDigestHour = (hour: number) =>
  db().execute(
    sql`INSERT INTO site_settings (\`key\`, \`value\`, updated_at)
        VALUES ('email.digest', ${JSON.stringify({ hour })}, NOW())
        ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = NOW()`,
  );

describe.skipIf(skipDb)("digest:run 脚本 · 真起进程", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("非配置时刻：空转、退出码 0、进程自行退出", async () => {
    await setDigestHour((beijingHour() + 1) % 24); // 保证 != 当前北京小时
    const r = await runScript(tdb.name);
    expect(r.hung, "脚本干完活后进程没有自行退出").toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`job=${DIGEST_JOB_KEY} status=ok`);
    expect(r.stdout).toMatch(/skipped: 北京 \d+ 点 != 配置 \d+ 点/);
  });

  it("到达配置时刻：执行并输出汇总，退出码 0，进程自行退出", async () => {
    await setDigestHour(beijingHour());
    const r = await runScript(tdb.name);
    expect(r.hung).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`job=${DIGEST_JOB_KEY} status=ok`);
    // 临时库无 opt-in 用户 → checked=0；关键是闸门放行且汇总出现
    expect(r.stdout).toMatch(/checked=\d+/);
    expect(r.stdout).toMatch(/skippedToday=\d+/);
  });

  it("与调度器共用同一把命名锁：别人持锁时本次被跳过，退出码 0", async () => {
    await setDigestHour(beijingHour());
    const handle = await createMysqlLocks().tryAcquire(DIGEST_JOB_KEY);
    expect(handle, "测试前提：锁应当可抢到").not.toBeNull();
    try {
      const r = await runScript(tdb.name);
      expect(r.hung).toBe(false);
      expect(r.code, "被跳过对周期调用来说是正常的").toBe(0);
      expect(r.stdout).toContain(`job=${DIGEST_JOB_KEY} status=skipped`);
      expect(r.stdout, "被跳过时不应出现处理汇总").not.toMatch(/checked=\d+/);
    } finally {
      await handle!.release();
    }
  });

  it("--force 免时刻闸：非配置时刻也执行", async () => {
    await setDigestHour((beijingHour() + 1) % 24);
    const r = await runScript(tdb.name, ["--force"]);
    expect(r.hung).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/checked=\d+/);
    expect(r.stdout).not.toMatch(/skipped: 北京/);
  });

  it("--user 指定用户免时刻闸：非配置时刻也执行", async () => {
    await setDigestHour((beijingHour() + 1) % 24);
    const r = await runScript(tdb.name, ["--user", "90005"]);
    expect(r.hung).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/checked=\d+/);
    expect(r.stdout).not.toMatch(/skipped: 北京/);
  });
});
