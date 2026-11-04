// @vitest-environment node
/**
 * 账号注销到期任务脚本（scripts/account-deletion-cron.mts）· 真起子进程的集成测试。
 *
 * 为什么必须真起进程：脚本的参数解析、退出码、「干完活进程会不会自行退出」都是进程级行为，
 * 单测调用服务函数覆盖不到。这里的「会自行退出」尤其重要：getWebDb 的连接池会一直占着事件循环，
 * 脚本若只设 exitCode，定时任务每调用一次就会留下一个不退出的进程——实测当前脚本就是如此。
 */
import { eq, sql } from "drizzle-orm";
import { accountDeletionRequests, getWebDb, users } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWebScript } from "@/test/script-runner";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { hashPassword } from "./password";
import { registerUser } from "./register";
import { requestAccountDeletionWithPassword } from "./account-deletion";

const runScript = (dbName: string, env: Record<string, string> = {}) =>
  runWebScript(dbName, "account-deletion-cron.mts", [], env);

let tdb: TempDb;
const db = () => getWebDb();

describe.skipIf(skipDb)("account-deletion:drain 脚本 · 真起进程", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("无到期申请时：输出 checked=0，退出码 0，进程自行退出", async () => {
    const r = await runScript(tdb.name);
    expect(r.hung, "脚本干完活后进程没有自行退出").toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/checked=0/);
  });

  it("有到期申请：处理完成，退出码 0，进程自行退出", async () => {
    const PASSWORD = "drain-test-pass";
    const userId = await registerUser({
      username: "drain_user",
      email: "drain@example.com",
      passwordHash: await hashPassword(PASSWORD),
      emailVerificationRequired: false,
      loginVerificationRequired: false,
      invite: null,
    });
    await db()
      .update(users)
      .set({ emailVerifiedAt: sql`NOW()` })
      .where(eq(users.id, userId));
    const created = await requestAccountDeletionWithPassword({ userId }, PASSWORD);
    // 把申请回拨到 8 天前（冷静期 7 天）
    await db()
      .update(accountDeletionRequests)
      .set({ scheduledAt: sql`NOW() - INTERVAL 8 DAY` })
      .where(eq(accountDeletionRequests.id, created.requestId));
    const r = await runScript(tdb.name);
    expect(r.hung).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/checked=1/);
    expect(r.stdout).toMatch(/completed=1/);
  });

  it("ACCOUNT_DELETION_BATCH_SIZE 环境变量生效", async () => {
    const r = await runScript(tdb.name, { ACCOUNT_DELETION_BATCH_SIZE: "999" });
    expect(r.hung).toBe(false);
    expect(r.code).toBe(0);
    // 日志里不会显示 limit，但至少确认脚本接受这个变量、正常执行并退出
  });
});
