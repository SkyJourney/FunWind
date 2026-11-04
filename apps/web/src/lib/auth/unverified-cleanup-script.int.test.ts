// @vitest-environment node
/**
 * 超期未验证账号清理脚本（scripts/unverified-accounts-cron.mts）· 真起子进程的集成测试。
 *
 * 为什么必须真起进程：脚本的参数解析、退出码、「干完活进程会不会自行退出」都是进程级行为，
 * 单测调用服务函数覆盖不到。这里的「会自行退出」尤其重要：getWebDb 的连接池会一直占着事件循环，
 * 脚本若只设 exitCode，定时任务每调用一次就会留下一个不退出的进程（account-deletion:drain 当前就是如此）。
 */
import { eq, sql } from "drizzle-orm";
import { getWebDb, users } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMysqlLocks } from "@/lib/scheduler/lock";
import { UNVERIFIED_PURGE_JOB_KEY } from "@/lib/scheduler/tasks";
import { runWebScript } from "@/test/script-runner";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { hashPassword } from "./password";
import { registerUser } from "./register";

const runScript = (dbName: string, args: string[]) =>
  runWebScript(dbName, "unverified-accounts-cron.mts", args);

let tdb: TempDb;
const db = () => getWebDb();
const state = async (id: number) =>
  (await db().select({ s: users.state }).from(users).where(eq(users.id, id)))[0]!.s;

let seq = 0;
async function makeGated(ageDays: number): Promise<number> {
  seq += 1;
  const id = await registerUser({
    username: `脚本${seq}`,
    email: `script${seq}@example.com`,
    passwordHash: await hashPassword("correct-horse-battery"),
    emailVerificationRequired: true,
    loginVerificationRequired: true,
    invite: null,
  });
  await db()
    .update(users)
    .set({ createdAt: sql`NOW() - INTERVAL ${sql.raw(String(ageDays))} DAY` })
    .where(eq(users.id, id));
  return id;
}

// 子进程冷启动（tsx 编译 + 连库）要好几秒，默认 5 秒单测超时不够；项目里现有写法见 content-source-guard.test.ts
describe.skipIf(skipDb)("unverified-accounts:purge 脚本 · 真起进程", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("默认只报告：列出将清理的账号、不删除、退出码 0，且进程自行退出", async () => {
    const overdue = await makeGated(10);
    const fresh = await makeGated(0);
    const r = await runScript(tdb.name, []);
    expect(r.hung, "脚本干完活后进程没有自行退出").toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("只报告");
    expect(r.stdout).toContain(String(overdue));
    expect(r.stdout).not.toMatch(new RegExp(`[:,]${fresh}(,|$)`, "m"));
    expect(await state(overdue)).toBe("active");
  });

  it("--apply 真正清理超期账号、保留新账号，进程自行退出，再跑一次幂等", async () => {
    const overdue = await makeGated(10);
    const fresh = await makeGated(0);
    const first = await runScript(tdb.name, ["--apply"]);
    expect(first.hung).toBe(false);
    expect(first.code).toBe(0);
    // --apply 走统一的任务执行器：日志是 job=… status=ok，摘要里带 checked/purged/failed
    expect(first.stdout).toContain(`job=${UNVERIFIED_PURGE_JOB_KEY} status=ok`);
    // 同一个临时库里前面的用例可能留下别的超期账号，所以不断言总数，而是断言「我造的这个」确实在清理名单里
    expect(first.stdout).toMatch(new RegExp(`ids=[\\d,]*\\b${overdue}\\b`));
    expect(await state(overdue)).toBe("deleted");
    expect(await state(fresh)).toBe("active");

    const second = await runScript(tdb.name, ["--apply"]);
    expect(second.hung).toBe(false);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("purged=0");
  });

  it("非法参数：--days=abc 在参数解析阶段失败；--apply --days=0 作为任务失败；都以退出码 1 结束且不清理任何账号", async () => {
    const fresh = await makeGated(0);
    const parse = await runScript(tdb.name, ["--days=abc"]);
    expect(parse.hung).toBe(false);
    expect(parse.code).toBe(1);
    expect(parse.stderr).toContain("worker failed");

    const job = await runScript(tdb.name, ["--apply", "--days=0"]);
    expect(job.hung).toBe(false);
    expect(job.code).toBe(1);
    expect(job.stderr + job.stdout).toContain(`job=${UNVERIFIED_PURGE_JOB_KEY} status=failed`);
    expect(job.stderr + job.stdout).toContain("天数必须是不小于 1 的整数");
    expect(await state(fresh)).toBe("active");
  });

  describe("与调度器共用同一把命名锁", () => {
    /** 在另一条连接上持有任务的命名锁，模拟「调度器或另一个实例正在执行」；返回释放函数 */
    async function holdTheLock(): Promise<() => Promise<void>> {
      const handle = await createMysqlLocks().tryAcquire(UNVERIFIED_PURGE_JOB_KEY);
      expect(handle, "测试前提：锁应当可抢到").not.toBeNull();
      return () => handle!.release();
    }

    it("--apply 遇到别人持锁：被跳过、不清理任何账号、退出码 0", async () => {
      const overdue = await makeGated(10);
      const release = await holdTheLock();
      try {
        const r = await runScript(tdb.name, ["--apply"]);
        expect(r.hung).toBe(false);
        expect(r.code, "被跳过对周期调用来说是正常的").toBe(0);
        expect(r.stdout).toContain(`job=${UNVERIFIED_PURGE_JOB_KEY} status=skipped`);
        expect(await state(overdue), "别人持锁时不能清理").toBe("active");
      } finally {
        await release();
      }
      // 锁释放后同样的命令能正常执行
      const again = await runScript(tdb.name, ["--apply"]);
      expect(again.stdout).toContain("status=ok");
      expect(await state(overdue)).toBe("deleted");
    });

    it("只报告是只读操作，不受别人持锁影响", async () => {
      const overdue = await makeGated(10);
      const release = await holdTheLock();
      try {
        const r = await runScript(tdb.name, []);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("只报告");
        expect(r.stdout).toContain(String(overdue));
      } finally {
        await release();
      }
    });
  });
});
