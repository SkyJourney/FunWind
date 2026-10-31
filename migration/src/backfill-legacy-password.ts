import { affectedRowsOf } from "@funwind/db";
import { oldQuery, newQuery } from "./db.js";
import { config } from "./config.js";

/**
 * 双轨密码回填（M10.6c，docs/PASSWORD-DUAL-TRACK.md 唯一合法写入方）：
 * 旧库 nw_windid_user（phpwind 口径 md5(md5(pwd)+salt)，salt 6 位）→ 新库 users 两列
 * （legacy_password_hash = `md5$<hash>$<salt>`，legacy_password_pending = 1）。
 *
 * 边界：只读旧库（db.ts 红线）；幂等（已有材料或已设密(password_hash)的账号跳过）；
 * 只回填新库存在的 active 账号。跑完输出对账计数，供 verify.ts 核验。
 *
 * 运行：pnpm --filter @funwind/migration exec tsx src/backfill-legacy-password.ts
 */

const BATCH = 2000;

async function main() {
  const [{ total }] = (await newQuery(
    "SELECT COUNT(*) AS total FROM users WHERE state = 'active' AND password_hash IS NULL",
  )) as { total: number }[];
  console.log(`[backfill] 候选：新库 active 且无密码的账号 ${total} 个`);

  let scanned = 0;
  let backfilled = 0;
  let skippedNoMaterial = 0;
  let maxUid = 0;

  for (;;) {
    const rows = (await oldQuery(
      "SELECT uid, password, salt FROM nw_windid_user WHERE uid > ? ORDER BY uid LIMIT ?",
      [maxUid, BATCH],
    )) as { uid: number; password: string; salt: string }[];
    if (rows.length === 0) break;
    for (const r of rows) {
      maxUid = r.uid;
      scanned++;
      if (!r.password || r.password.length !== 32 || !r.salt) {
        skippedNoMaterial++;
        continue;
      }
      const stored = `md5$${r.password}$${r.salt}`;
      // pool.query 的 UPDATE 结果是 ResultSetHeader（非行数组）
      const affectedRows = affectedRowsOf(
        await newQuery(
          "UPDATE users SET legacy_password_hash = ?, legacy_password_pending = 1 " +
            "WHERE id = ? AND state = 'active' AND password_hash IS NULL AND legacy_password_hash IS NULL",
          [stored, r.uid],
        ),
      );
      backfilled += affectedRows > 0 ? 1 : 0;
    }
    console.log(`[backfill] 已扫描到 uid=${maxUid}（本批 ${rows.length}）`);
  }

  const [{ done }] = (await newQuery(
    "SELECT COUNT(*) AS done FROM users WHERE legacy_password_pending = 1",
  )) as { done: number }[];
  console.log(
    `[backfill] 完成：扫描 ${scanned}，回填 ${backfilled}，无材料跳过 ${skippedNoMaterial}；新库 pending 总数 ${done}`,
  );
  console.log(
    `[backfill] 核验口径（verify.ts）：pending 总数应等于「active+无密码+旧库有材料」的交集数；`,
  );
  console.log(`[backfill] 目标库 ${config.newDb.database}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfill] 失败：", e);
  process.exit(1);
});
