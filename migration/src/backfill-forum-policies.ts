import { affectedRowsOf } from "@funwind/db";
import { oldQuery, newQuery } from "./db.js";

/**
 * 版块可见性策略回填（M10.6 收尾，站长 2026-10-28 指示；旧站设置本体 = nw_bbs_forum.allow_* 列）：
 *
 * 旧组语义（nw_user_groups）：2=游客、1=注册默认组、6=禁止发言、7=未验证会员、
 * 8-13/28-33=等级组 LV1-12（40 为已删组残留）、3/4/5=管理（大魔王/领主/守卫）、
 * 18/21/23/36/37/38=特殊组（字幕制作/技术分流/实习/资源/美工/策划）。
 *
 * 映射规则（忠实旧数据）：
 *  · allow_read 空 或 含游客(2)/默认组(1) → read_policy=public；
 *  · allow_read 非空且全部 ∈ 工作组集合 → restricted（仅六个：121/123/130/152/129/53）；
 *  · 其余组合 → members（保守回落，当前旧数据未出现）。
 *  · allow_post/allow_reply 同理映射 write_policy（空=members：游客本就不能发帖）。
 *  · restricted 版块为六个 team-* 角色补 scope 版块级 forum.read/forum.write 授权
 *    （121/123/130/152 已在 M5.5 迁入，幂等补 53/129）；组 3/4/5 成员已并入 builtin admin（全局放行）。
 *
 * 幂等：UPDATE 直写目标值、INSERT IGNORE 授权（唯一键 uq_rg_grant）；重跑结果一致。
 * 审计：audit_log 每版块一条（actor NULL=CLI，via=cli）。跑完 30s TTL 后权限快照自动收敛。
 *
 * 运行：pnpm --filter @funwind/migration exec tsx src/backfill-forum-policies.ts
 */

/** 旧工作组集合（system + special；决策依据见文件头） */
const STAFF_GIDS = new Set([3, 4, 5, 18, 21, 23, 36, 37, 38]);
/** 等级组（LV1-12；40 为已删组残留，不影响判定） */
const MEMBER_LEVEL_GIDS = new Set([8, 9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 33, 40]);

const TEAM_ROLES = [
  "team-subtitle",
  "team-tech",
  "team-intern",
  "team-planning",
  "team-art",
  "team-resource",
];

const parseGids = (raw: string): number[] =>
  raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

type ReadClass = "public" | "members" | "restricted";

function classifyRead(csv: string): ReadClass {
  const gids = parseGids(csv);
  if (gids.length === 0) return "public"; // 旧默认：不限制
  if (gids.some((g) => g === 2 || g === 1)) return "public"; // 游客/注册默认组可读
  if (gids.some((g) => MEMBER_LEVEL_GIDS.has(g))) return "members"; // 等级组可读、游客不可
  if (gids.every((g) => STAFF_GIDS.has(g))) return "restricted"; // 纯工作组
  return "members"; // 未知组合保守回落（当前旧数据未出现）
}

function classifyWrite(csv: string): "members" | "restricted" {
  const gids = parseGids(csv);
  if (gids.length === 0) return "members"; // 旧默认：登录即可发
  if (gids.every((g) => STAFF_GIDS.has(g))) return "restricted";
  return "members";
}

async function main() {
  const oldForums = (await oldQuery(
    "SELECT fid, name, allow_visit, allow_read, allow_post, allow_reply FROM nw_bbs_forum ORDER BY fid",
  )) as {
    fid: number;
    name: string;
    allow_visit: string;
    allow_read: string;
    allow_post: string;
    allow_reply: string;
  }[];

  const newForums = (await newQuery("SELECT id FROM forums")) as { id: number }[];
  const newIds = new Set(newForums.map((r) => r.id));

  let updated = 0;
  let restrictedCount = 0;
  const restrictedFids: number[] = [];
  const unmatched: number[] = [];

  for (const f of oldForums) {
    if (!newIds.has(f.fid)) {
      unmatched.push(f.fid);
      continue;
    }
    const readPolicy = classifyRead(f.allow_read);
    const writePolicy =
      classifyWrite(f.allow_post) === "restricted" || classifyWrite(f.allow_reply) === "restricted"
        ? "restricted"
        : "members";
    if (readPolicy === "restricted") {
      restrictedCount++;
      restrictedFids.push(f.fid);
    }
    await newQuery("UPDATE forums SET read_policy = ?, write_policy = ? WHERE id = ?", [
      readPolicy,
      writePolicy,
      f.fid,
    ]);
    await newQuery(
      "INSERT INTO audit_log (actor_id, action, target_type, target_id, before_json, after_json, created_at) " +
        "VALUES (NULL, 'forum.policy_backfill', 'forum', ?, NULL, ?, NOW())",
      [
        String(f.fid),
        JSON.stringify({
          via: "cli",
          source: "nw_bbs_forum.allow_*",
          readPolicy,
          writePolicy,
          allowRead: f.allow_read,
          allowPost: f.allow_post,
        }),
      ],
    );
    updated++;
  }

  // restricted 版块补齐六个 team-* 角色的版块作用域授权（唯一键幂等）
  let grantsAdded = 0;
  for (const fid of restrictedFids) {
    for (const role of TEAM_ROLES) {
      for (const perm of ["forum.read", "forum.write"]) {
        const affectedRows = affectedRowsOf(
          await newQuery(
            "INSERT IGNORE INTO role_grants (role_key, permission_key, scope_id) VALUES (?, ?, ?)",
            [role, perm, fid],
          ),
        );
        grantsAdded += affectedRows > 0 ? 1 : 0;
      }
    }
  }

  console.log(
    `[policy-backfill] 旧版块 ${oldForums.length}，回填 ${updated}，restricted ${restrictedCount}（fid: ${restrictedFids.join(", ")}），新授权 ${grantsAdded} 条`,
  );
  console.log(
    `[policy-backfill] 新库缺失的旧 fid：${unmatched.length ? unmatched.join(", ") : "（无）"}`,
  );
  console.log("[policy-backfill] 权限快照 TTL 30s 后自动收敛（或重启 web 进程立即生效）");
  process.exit(0);
}

main().catch((e) => {
  console.error("[policy-backfill] 失败：", e);
  process.exit(1);
});
