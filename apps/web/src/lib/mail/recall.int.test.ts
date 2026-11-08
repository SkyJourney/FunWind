// @vitest-environment node
/**
 * 社区重启召回集成测试（M13 Step 4，D4）：白名单过滤（注销/无邮箱/全局封禁生效中）、
 * 不该拦的放行（封禁已过期、版块级封禁）、email_log 场景防重（sent 跳过、failed 可重发）、
 * dry-run 不发送、分批限速与单封重试。发送函数注入（模拟 transport：成功/失败都写 email_log）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailLog, getWebDb, userRestrictions, users } from "@funwind/db";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import type { MailMessage } from "./types";
import { maskEmail, RECALL_SCENE, recallPlan, runRecallBlast } from "./recall";

let tdb: TempDb | undefined;
const NOW = "2026-11-08 10:00:00";

const mk = (
  id: number,
  opts: { email?: string | null; password?: boolean; deleted?: boolean } = {},
) => {
  const email = opts.email === undefined ? `user${id}@example.test` : opts.email;
  return {
    id,
    username: `old_user_${id}`,
    usernameKey: `old_user_${id}`,
    email,
    emailKey: email ? email.toLowerCase() : null,
    passwordHash: opts.password ? "$argon2id$v=19$m=65536,t=3,p=4$placeholder" : null,
    state: (opts.deleted ? "deleted" : "active") as "active" | "deleted",
    createdAt: NOW,
  };
};

beforeAll(async () => {
  tdb = await setupTempDb({ demo: false });
  const db = getWebDb();
  await db.insert(users).values([
    mk(901), // 未认领老账号 → 发（认领引导）
    mk(902, { password: true }), // 已设密 → 发（登录引导）
    mk(903, { email: null }), // 无邮箱 → 滤
    mk(904, { deleted: true }), // 已注销 → 滤
    mk(905), // 全局永久封禁 → 滤
    mk(906), // 全局封禁已过期 → 发
    mk(907), // 仅版块级封禁 → 发（不挡召回）
    mk(908), // 已发过（sent）→ 防重跳过
    mk(909), // 上次失败（failed）→ 可重发
  ]);
  await db.insert(userRestrictions).values([
    { userId: 905, kind: "ban", scopeId: 0, startsAt: NOW, endsAt: null, createdAt: NOW },
    {
      userId: 906,
      kind: "ban",
      scopeId: 0,
      startsAt: "2020-01-01 00:00:00",
      endsAt: "2021-01-01 00:00:00",
      createdAt: NOW,
    },
    { userId: 907, kind: "forum_ban", scopeId: 12, startsAt: NOW, endsAt: null, createdAt: NOW },
  ]);
  const log = (userId: number, status: "sent" | "failed") => ({
    kind: "notice",
    scene: RECALL_SCENE,
    toEmail: `user${userId}@example.test`,
    userId,
    subject: "s",
    status,
    createdAt: NOW,
  });
  await db.insert(emailLog).values([log(908, "sent"), log(909, "failed")]);
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("社区重启召回（M13 D4）", () => {
  it("recallPlan：白名单过滤 + 防重统计（sent 跳过、failed 可重发）", async () => {
    const plan = await recallPlan(20);
    expect(plan.samples.map((s) => s.id)).toEqual([901, 902, 906, 907, 909]);
    expect(plan.eligible).toBe(5);
    expect(plan.alreadySent).toBe(1); // 908
    expect(plan.filtered).toBe(3); // 903 无邮箱、904 注销、905 封禁
    expect(plan.samples.find((s) => s.id === 901)?.claimed).toBe(false);
    expect(plan.samples.find((s) => s.id === 902)?.claimed).toBe(true);
  });

  it("dry-run（apply=false）：不调用发送", async () => {
    let calls = 0;
    const result = await runRecallBlast({
      apply: false,
      send: async () => {
        calls += 1;
        return true;
      },
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ sent: 0, failed: 0, batches: 0 });
  });

  it("--apply：分批 + 单封重试 + 失败不阻断；重跑按 email_log 防重只补发失败者", async () => {
    const attempts = new Map<number, number>();
    const mails = new Map<number, MailMessage>();
    const sleeps: number[] = [];
    // 模拟 transport：906 首次失败二次成功（验证重试）；909 始终失败（验证计数与续跑）
    const send = async (to: string, message: MailMessage, userId: number) => {
      const n = (attempts.get(userId) ?? 0) + 1;
      attempts.set(userId, n);
      mails.set(userId, message);
      const ok = userId === 909 ? false : !(userId === 906 && n === 1);
      await getWebDb()
        .insert(emailLog)
        .values({
          kind: "notice",
          scene: RECALL_SCENE,
          toEmail: to,
          userId,
          subject: message.subject,
          status: ok ? "sent" : "failed",
          createdAt: NOW,
        });
      return ok;
    };
    const result = await runRecallBlast({
      apply: true,
      batchSize: 2,
      batchIntervalMs: 1000,
      send,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toEqual({ sent: 4, failed: 1, batches: 3 }); // 5 封 / 每批 2 = 3 批
    expect(attempts.get(906)).toBe(2); // 失败一次后重试成功
    expect(attempts.get(909)).toBe(2); // 重试上限 1 次，仍失败计 failed
    expect(sleeps.filter((ms) => ms === 1000)).toHaveLength(2); // 批间隔只在批之间（3 批 → 2 次）
    // 文案分流：未认领 → 找回页认领；已设密 → 登录
    expect(mails.get(901)?.html).toContain("/forgot");
    expect(mails.get(901)?.html).toContain("认领");
    expect(mails.get(902)?.html).toContain("/login");
    expect(mails.get(901)?.scene).toBe(RECALL_SCENE);

    // 重跑：已 sent 的全部跳过，只剩 909（failed 可重发）
    const plan = await recallPlan();
    expect(plan.samples.map((s) => s.id)).toEqual([909]);
    expect(plan.alreadySent).toBe(5); // 908 + 本轮 4 封
  });

  it("maskEmail：终端日志不出完整地址", () => {
    expect(maskEmail("alice@example.com")).toBe("a****@example.com");
    expect(maskEmail("ab@x.io")).toBe("a***@x.io");
    expect(maskEmail("broken")).toBe("***");
  });
});
