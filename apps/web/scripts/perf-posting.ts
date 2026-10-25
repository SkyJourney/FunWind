#!/usr/bin/env node
/**
 * 发帖性能基准（M6.5d，服务层）：在 e2e 库上顺序执行 N 次 createReply，输出 p50 / p95 / p99。
 * 用法（须显式指定 e2e 库，脚本拒绝任何其它库名——开发库 qysub_next 不会被它写入）：
 *   NEW_DB_NAME=qysub_next_e2e pnpm --filter @funwind/web perf:posting
 * 范围：权限评估、限制读取、事务（锁 + 插入 + 计数）、事件派发。Server Action 只能经 Next 运行时调用，
 * 所以这里测的是服务层；HTTP 层基准留到 M13 部署环境（见 docs/milestones/M6.5-gates-polish.md §6）。
 * 失败线：p95 ≥ 300ms 时非零退出。
 */
import { config as loadDotenv } from "dotenv";
import type { RowDataPacket } from "mysql2";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { getWebPool } from "@funwind/db";
import { createReply } from "../src/lib/posting/service";
import { loadSubject } from "../src/lib/authz/subject";
import "../src/modules";

// 先读根 .env（与 packages/db 同源），再做库名守卫：.env 里的 NEW_DB_NAME 也要被检查
loadDotenv({ path: path.resolve(__dirname, "../../../.env"), override: false, quiet: true });

const REQUIRED_DB = "qysub_next_e2e";
if (process.env.NEW_DB_NAME !== REQUIRED_DB) {
  console.error(
    `拒绝运行：perf:posting 只允许在 ${REQUIRED_DB} 上执行，当前 NEW_DB_NAME=${process.env.NEW_DB_NAME ?? "(未设置)"}`,
  );
  process.exit(2);
}

const N = 200; // 正式样本数
const WARMUP = 5; // 预热：首次调用会建立权限快照与连接，不计入样本
const P95_LIMIT_MS = 300;
const MEMBER = 90005; // 会员（演示种子用户，已购买门控）
const FORUM = 954; // 公开、不审核的发帖版块
const TID = 970101; // 本脚本专用主题（每次运行前重建）
const PID = 970201;

const pool = getWebPool();

/** 准备基准数据并临时放宽会员发帖间隔；返回还原函数（finally 中调用） */
async function setup(): Promise<() => Promise<void>> {
  // 临时关掉会员发帖间隔，否则顺序回帖会被 too_frequent 拦下
  const [rows] = await pool.query<(RowDataPacket & { value: unknown })[]>(
    "SELECT value FROM site_settings WHERE `key` = 'limits'",
  );
  const original = rows[0]?.value;
  const current = (typeof original === "string" ? JSON.parse(original) : original) as {
    roles: Record<string, Record<string, unknown>>;
  };
  const relaxed = {
    ...current,
    roles: { ...current.roles, member: { ...current.roles.member, postIntervalSec: 0 } },
  };
  await pool.query(
    "INSERT INTO site_settings (`key`, value, updated_at) VALUES ('limits', ?, NOW()) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()",
    [JSON.stringify(relaxed)],
  );
  await pool.query("DELETE FROM posts WHERE thread_id = ?", [TID]);
  await pool.query("DELETE FROM threads WHERE id = ?", [TID]);
  await pool.query(
    `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, created_at, last_posted_at)
     VALUES (?, ?, 90002, '[perf] 发帖基准主题', ?, 'visible', '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
    [TID, FORUM, PID],
  );
  await pool.query(
    `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
     VALUES (?, ?, 1, 90002, '基准首帖', 0, 'visible', '2026-10-21 10:00:00')`,
    [PID, TID],
  );
  return async () => {
    await pool.query(
      "UPDATE site_settings SET value = ?, updated_at = NOW() WHERE `key` = 'limits'",
      [JSON.stringify(current)],
    );
  };
}

/** 最近秩分位数（nearest-rank）；sorted 须已升序 */
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

async function main(): Promise<number> {
  const restore = await setup();
  try {
    const subject = await loadSubject(MEMBER);
    const samples: number[] = [];
    for (let i = 0; i < WARMUP + N; i++) {
      const t0 = performance.now();
      const r = await createReply(subject, {
        threadId: TID,
        source: `性能基准回复 ${i} ${Date.now()}`,
      });
      const dt = performance.now() - t0;
      if (!r.ok) {
        console.error(`第 ${i} 次回帖失败：${r.code} ${r.message}`);
        return 1;
      }
      if (i >= WARMUP) samples.push(dt);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const fmt = (x: number) => x.toFixed(1).padStart(7);
    console.log(`发帖基准（createReply，服务层，会员，样本 ${N}，预热 ${WARMUP}）`);
    console.log(`  p50  ${fmt(p50)} ms`);
    console.log(`  p95  ${fmt(p95)} ms`);
    console.log(`  p99  ${fmt(p99)} ms`);
    console.log(
      `  mean ${fmt(mean)} ms   min ${fmt(sorted[0]!)} ms   max ${fmt(sorted.at(-1)!)} ms`,
    );
    const pass = p95 < P95_LIMIT_MS;
    console.log(
      `${pass ? "通过" : "未通过"}：p95 ${p95.toFixed(1)} ms ${pass ? "<" : "≥"} ${P95_LIMIT_MS} ms`,
    );
    return pass ? 0 : 1;
  } finally {
    await restore();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
