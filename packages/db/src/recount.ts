/**
 * 缓存计数的全量重算（M6.1 第 4 步）。
 *
 * 计数列（threads.reply_count、threads 的 last_* 指针、forums.*、user_stats.*、posts.like_count、tags.thread_count）
 * 只是明细的缓存：本模块用「明细 → 计数」的纯 SQL 口径整体推导一遍。迁移导入与 `db:recount` 共用这一份口径，
 * 口径与写路径预言机（apps/web/src/test/posting-oracle.ts）逐条一致：
 * - 主题回复数 = 可见的 floor>1 回帖数；主题最后回复 = 可见帖中楼层最大者，无可见帖时指针为 NULL、时间回落 created_at
 * - 版块只统计可见主题 / 可见帖；版块最后发表 = 可见主题里最近活跃者
 * - 用户统计对全部用户（含占位账号）补行并重算；精华数 = 被设为精华的可见主题
 *
 * 执行方式：单事务，按固定顺序（user_stats → threads → posts → tags → forums，与写路径的加锁顺序一致）逐组执行。
 * 每组先建临时快照表，执行后与快照比对，得到「每张表、每列被修正了多少行」——这既是 `--check` 的漂移报告，
 * 也是修正的真实行数。dryRun 时在比对完成后回滚，数据库保持原样。
 * 注意：应在无并发写入时执行；有并发写入时结果只反映快照时刻，漂移可能被再次报出（这正是 `--check` 的用途）。
 */
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

/** 单张表的重算结果 */
export interface RecountTableReport {
  /** 表名 */
  table: string;
  /** 本次被修正（至少一列与明细推导不同）的行数；dryRun 时为「若执行将修正」的行数 */
  rows: number;
  /** 新建的行数（仅 user_stats：为缺行的用户补行） */
  created: number;
  /** 每列被修正的行数（同一行多列变化会在多列中各计一次） */
  byColumn: Record<string, number>;
}

/** 全量重算的报告 */
export interface RecountReport {
  /** 是否为干跑（已回滚，数据库未改动） */
  dryRun: boolean;
  /** 按执行顺序排列的各表结果 */
  tables: RecountTableReport[];
}

/** 一组 = 一张被重算的表：主键、被重算的列、按序执行的 SQL */
interface RecountGroup {
  table: string;
  key: string;
  columns: string[];
  statements: string[];
}

/**
 * 重算口径（顺序即加锁顺序，见模块注释）。
 * 注意：每条 SQL 与预言机 reset 口径一致，修改任一条须同步检查预言机测试。
 */
const GROUPS: RecountGroup[] = [
  {
    table: "user_stats",
    key: "user_id",
    columns: ["thread_count", "post_count", "featured_count", "follower_count", "last_post_at"],
    statements: [
      `INSERT INTO user_stats (user_id)
       SELECT u.id FROM users u LEFT JOIN user_stats s ON s.user_id = u.id WHERE s.user_id IS NULL`,
      `UPDATE user_stats us SET
         thread_count = (SELECT COUNT(*) FROM threads t WHERE t.author_id = us.user_id AND t.state = 'visible'),
         post_count = (SELECT COUNT(*) FROM posts p WHERE p.author_id = us.user_id AND p.state = 'visible'),
         featured_count = (SELECT COALESCE(SUM(t.is_featured), 0) FROM threads t
                            WHERE t.author_id = us.user_id AND t.state = 'visible'),
         follower_count = (SELECT COUNT(*) FROM follows f WHERE f.target_type = 'user' AND f.target_id = us.user_id),
         last_post_at = (SELECT MAX(p.created_at) FROM posts p WHERE p.author_id = us.user_id AND p.state = 'visible')`,
    ],
  },
  {
    table: "threads",
    key: "id",
    columns: ["reply_count", "last_post_id", "last_poster_id", "last_posted_at"],
    statements: [
      `UPDATE threads t SET
         reply_count = (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id AND p.floor > 1 AND p.state = 'visible'),
         last_post_id = (SELECT p.id FROM posts p WHERE p.thread_id = t.id AND p.state = 'visible'
                          ORDER BY p.floor DESC LIMIT 1),
         last_poster_id = (SELECT p.author_id FROM posts p WHERE p.thread_id = t.id AND p.state = 'visible'
                            ORDER BY p.floor DESC LIMIT 1),
         last_posted_at = COALESCE((SELECT p.created_at FROM posts p WHERE p.thread_id = t.id AND p.state = 'visible'
                                     ORDER BY p.floor DESC LIMIT 1), t.created_at)`,
    ],
  },
  {
    table: "posts",
    key: "id",
    columns: ["like_count"],
    statements: [
      `UPDATE posts p SET p.like_count = (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id AND r.kind = 'like')`,
    ],
  },
  {
    table: "tags",
    key: "id",
    columns: ["thread_count"],
    statements: [
      `UPDATE tags t SET t.thread_count = (
         SELECT COUNT(*) FROM thread_tags tt JOIN threads th ON th.id = tt.thread_id
          WHERE tt.tag_id = t.id AND th.state = 'visible')`,
    ],
  },
  {
    table: "forums",
    key: "id",
    columns: ["thread_count", "post_count", "last_post_id", "last_posted_at"],
    statements: [
      `UPDATE forums f SET
         thread_count = (SELECT COUNT(*) FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible'),
         post_count = (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id
                        WHERE t.forum_id = f.id AND t.state = 'visible' AND p.state = 'visible'),
         last_post_id = (SELECT t.last_post_id FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible'
                          ORDER BY t.last_posted_at DESC, t.id DESC LIMIT 1),
         last_posted_at = (SELECT t.last_posted_at FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible'
                            ORDER BY t.last_posted_at DESC, t.id DESC LIMIT 1)`,
    ],
  },
];

/** 快照表名（临时表，按表区分） */
const snapshotName = (table: string) => `rc_before_${table}`;

/**
 * 执行一组：建快照 → 执行口径 SQL → 与快照比对。
 * 比对 SQL 每列一个计数，用 `<=>` 做空值安全比较；新建行（快照中不存在）单独计数。
 */
async function runGroup(conn: PoolConnection, g: RecountGroup): Promise<RecountTableReport> {
  const snap = snapshotName(g.table);
  const cols = [g.key, ...g.columns];
  await conn.query(`DROP TEMPORARY TABLE IF EXISTS ${snap}`);
  try {
    await conn.query(
      `CREATE TEMPORARY TABLE ${snap} (PRIMARY KEY (${g.key})) SELECT ${cols.join(", ")} FROM ${g.table}`,
    );
    for (const s of g.statements) await conn.query(s);

    // 每列一个 SUM；列别名用下标，避免列名转义
    const byColSql = g.columns.map(
      (c, i) => `SUM(b.${g.key} IS NOT NULL AND NOT (t.${c} <=> b.${c})) AS c${i}`,
    );
    const anyChanged = g.columns.map((c) => `NOT (t.${c} <=> b.${c})`).join(" OR ");
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT SUM(b.${g.key} IS NULL) AS created,
              SUM(b.${g.key} IS NOT NULL AND (${anyChanged})) AS changed,
              ${byColSql.join(", ")}
         FROM ${g.table} t LEFT JOIN ${snap} b ON b.${g.key} = t.${g.key}`,
    );
    const r = rows[0] ?? {};
    const byColumn: Record<string, number> = {};
    g.columns.forEach((c, i) => {
      byColumn[c] = Number(r[`c${i}`] ?? 0);
    });
    return {
      table: g.table,
      rows: Number(r.changed ?? 0),
      created: Number(r.created ?? 0),
      byColumn,
    };
  } finally {
    await conn.query(`DROP TEMPORARY TABLE IF EXISTS ${snap}`);
  }
}

/**
 * 全量重算全部缓存计数。
 * @param pool 连接池；本函数自取一条连接开事务，结束后归还
 * @param opts.dryRun 为 true 时比对后回滚，数据库不变（`db:recount --check` 用）
 * @returns 各表被修正（或将被修正）的行数
 * @throws 任一组执行失败时整体回滚并抛出原始错误
 */
export async function recountAll(
  pool: Pool,
  opts: { dryRun?: boolean } = {},
): Promise<RecountReport> {
  const dryRun = opts.dryRun === true;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const tables: RecountTableReport[] = [];
    try {
      for (const g of GROUPS) tables.push(await runGroup(conn, g));
      if (dryRun) await conn.rollback();
      else await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }
    return { dryRun, tables };
  } finally {
    conn.release();
  }
}

/** 报告中的漂移总行数（所有表的修正行数 + 新建行数） */
export function recountDriftTotal(report: RecountReport): number {
  return report.tables.reduce((n, t) => n + t.rows + t.created, 0);
}

/**
 * 把报告格式化为控制台行（纯函数，便于单测）。
 * 干跑用「将修正」措辞，真实执行用「已修正」；只列出有变化的列。
 */
export function formatRecountReport(report: RecountReport): string[] {
  const total = recountDriftTotal(report);
  const verb = report.dryRun ? "将修正" : "已修正";
  const head = report.dryRun
    ? `计数检查（只读，已回滚）：漂移合计 ${total} 行`
    : `计数重算：${verb}合计 ${total} 行`;
  const lines = [head];
  for (const t of report.tables) {
    const created = t.created > 0 ? `新建 ${t.created} 行，` : "";
    const cols = Object.entries(t.byColumn)
      .filter(([, n]) => n > 0)
      .map(([c, n]) => `${c} ${n}`);
    const detail = cols.length > 0 ? `（${cols.join("，")}）` : "";
    lines.push(`  ${t.table.padEnd(12)}${created}${verb} ${t.rows} 行${detail}`);
  }
  return lines;
}

/**
 * 退出码：`--check`（干跑）且存在漂移返回 1，其余返回 0。
 * 真实执行即使修正了数据也返回 0——修正本身就是目的，幂等后下一次会得到 0。
 */
export function recountExitCode(report: RecountReport): number {
  return report.dryRun && recountDriftTotal(report) > 0 ? 1 : 0;
}
