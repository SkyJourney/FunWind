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
    expect(first.stdout).toContain("已执行");
    expect(await state(overdue)).toBe("deleted");
    expect(await state(fresh)).toBe("active");

    const second = await runScript(tdb.name, ["--apply"]);
    expect(second.hung).toBe(false);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("purged=0");
  });

  it("非法参数：--days=0 与 --days=abc 都以退出码 1 结束，且不会清理任何账号", async () => {
    const fresh = await makeGated(0);
    for (const args of [["--apply", "--days=0"], ["--days=abc"]]) {
      const r = await runScript(tdb.name, args);
      expect(r.hung).toBe(false);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr).toContain("worker failed");
    }
    expect(await state(fresh)).toBe("active");
  });
});
