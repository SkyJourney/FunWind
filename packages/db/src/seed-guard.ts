/**
 * 演示 / E2E 种子的生产守卫（审查 P2-14）。
 *
 * 演示种子会写入固定口令的演示管理员（demo_admin 等）与固定邀请码，E2E 夹具会写入固定 id 的版块与帖子。
 * 在真实站点库上误跑等于开了一个已知口令的后门，所以默认拒绝，须显式 `--force`。
 *
 * 拒绝条件（任一）：
 *  · `NODE_ENV=production`；
 *  · 目标库里已有**非演示**用户——真实注册用户或迁移导入的用户。只有演示 / E2E 账号（用户名键以 `demo_` / `e2e_` 开头）
 *    的库视为纯演示库，可以重复跑（种子本身是幂等的），空库当然允许。
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/** 演示种子与 E2E 夹具创建的账号用户名键前缀（见 seed-data.ts / e2e-fixtures.ts） */
export const DEMO_USERNAME_KEY_PREFIXES = ["demo_", "e2e_"] as const;

export interface SeedTargetFacts {
  nodeEnv: string | undefined;
  /** 非演示账号数量 */
  foreignUsers: number;
}

export type SeedVerdict = { ok: true; forced: boolean } | { ok: false; reasons: string[] };

/** 纯判定：给定事实与是否 --force，决定能否继续 */
export function assessSeedTarget(facts: SeedTargetFacts, force: boolean): SeedVerdict {
  const reasons: string[] = [];
  if (facts.nodeEnv === "production") reasons.push("NODE_ENV=production");
  if (facts.foreignUsers > 0) {
    reasons.push(`目标库里已有 ${facts.foreignUsers} 个非演示用户（真实注册或迁移导入的账号）`);
  }
  if (reasons.length === 0) return { ok: true, forced: false };
  return force ? { ok: true, forced: true } : { ok: false, reasons };
}

/** 查询目标库中的非演示用户数（用户名键不以演示前缀开头；`_` 在 LIKE 里要转义） */
export async function countForeignUsers(db: Db): Promise<number> {
  const conds = DEMO_USERNAME_KEY_PREFIXES.map(
    (p) => sql`username_key NOT LIKE ${p.replace("_", "\\_") + "%"}`,
  );
  const [row] = (await db.execute(
    sql`SELECT COUNT(*) AS n FROM users WHERE ${sql.join(conds, sql` AND `)}`,
  )) as unknown as [{ n: number | string }[]];
  return Number(row?.[0]?.n ?? 0);
}

/**
 * 种子脚本入口调用：不通过则打印原因并抛错（脚本以非零码退出）。
 * `argv` 传 process.argv，`env` 传 process.env，便于测试注入。
 */
export async function assertSeedAllowed(
  db: Db,
  label: string,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.error,
): Promise<void> {
  const verdict = assessSeedTarget(
    { nodeEnv: env.NODE_ENV, foreignUsers: await countForeignUsers(db) },
    argv.includes("--force"),
  );
  if (!verdict.ok) {
    log(`✘ 拒绝运行 ${label}：\n${verdict.reasons.map((r) => `  · ${r}`).join("\n")}`);
    log(
      "  演示数据含固定口令的演示管理员，不应出现在真实站点库。确认目标库无误时加 --force 覆盖。",
    );
    throw new Error(`${label} 被生产守卫拒绝`);
  }
  if (verdict.forced) log(`⚠ ${label}：生产守卫已被 --force 覆盖`);
}
