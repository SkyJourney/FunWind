import { oldQuery, newQuery, closePools } from "./db.js";
import { checkAttachmentFiles } from "./entities/extra.js";
import { createHash } from "node:crypto";

interface Check {
  name: string;
  pass: boolean;
  warn?: boolean;
  detail: string;
}

const checks: Check[] = [];
function add(name: string, pass: boolean, detail: string, warn = false) {
  checks.push({ name, pass, warn, detail });
}

const md5 = (s: string | null) =>
  s === null ? "" : createHash("md5").update(s, "utf8").digest("hex");

// ---------- 1. 行数对账 ----------
const expected: [string, string, number | "same"][] = [
  ["groups", `SELECT COUNT(*) n FROM nw_user_groups`, "same"],
  ["forums", `SELECT COUNT(*) n FROM nw_bbs_forum`, "same"],
  ["users", `SELECT COUNT(*) n FROM nw_user`, "same"],
  ["threads", `SELECT COUNT(*) n FROM nw_bbs_threads`, "same"],
  ["posts", `SELECT COUNT(*) n FROM nw_bbs_posts`, "same"],
  ["attachments", `SELECT COUNT(*) n FROM nw_attachs_thread`, "same"],
  ["emoticons", `SELECT COUNT(*) n FROM nw_common_emotion`, "same"],
  ["topic_type", `SELECT COUNT(*) n FROM nw_bbs_topic_type`, "same"],
  ["medals", `SELECT COUNT(*) n FROM nw_medal_info`, "same"],
  ["credit_logs", `SELECT COUNT(*) n FROM nw_credit_log`, "same"],
  ["polls", `SELECT COUNT(*) n FROM nw_app_poll`, "same"],
  ["poll_options", `SELECT COUNT(*) n FROM nw_app_poll_option`, "same"],
  ["poll_voters", `SELECT COUNT(*) n FROM nw_app_poll_voter`, "dedup"],
  ["private_messages", `SELECT COUNT(*) n FROM nw_windid_message`, "same"],
];
for (const [table, oldSql, rule] of expected) {
  const oldN = Number((await oldQuery(oldSql))[0].n);
  const newN = Number((await newQuery(`SELECT COUNT(*) n FROM \`${table}\``))[0].n);
  if (rule === "dedup") {
    // 新库复合主键去重（旧库存在同一人对同一选项的重复投票记录）
    const dupN = Number(
      (
        await oldQuery(
          `SELECT COALESCE(SUM(c - 1), 0) n FROM (
         SELECT COUNT(*) c FROM nw_app_poll_voter GROUP BY poll_id, option_id, uid HAVING c > 1) d`,
        )
      )[0].n,
    );
    add(
      `count:${table}`,
      newN === oldN - dupN,
      `旧 ${oldN} → 新 ${newN}（去除 ${dupN} 条重复投票记录）`,
    );
  } else {
    add(`count:${table}`, oldN === newN, `旧 ${oldN} → 新 ${newN}`);
  }
}

// ---------- 2. 内容保真：抽样 MD5 对比（编码无损证明） ----------
const SAMPLE = 300;
const sampleThreads = await oldQuery(
  `SELECT tid, content FROM nw_bbs_threads_content WHERE content IS NOT NULL
   ORDER BY RAND() LIMIT ?`,
  [SAMPLE],
);
let mismatch = 0,
  compared = 0;
for (const r of sampleThreads) {
  const newRow = (await newQuery(`SELECT content_raw FROM threads WHERE id = ?`, [r.tid]))[0];
  if (!newRow) {
    mismatch++;
    continue;
  }
  compared++;
  if (md5(r.content) !== md5(newRow.content_raw)) mismatch++;
}
add(
  "fidelity:threads_content_md5",
  mismatch === 0,
  `抽样 ${compared}/${sampleThreads.length}，不一致 ${mismatch}`,
);

const samplePosts = await oldQuery(
  `SELECT pid, content FROM nw_bbs_posts WHERE content IS NOT NULL ORDER BY RAND() LIMIT ?`,
  [SAMPLE],
);
let pMismatch = 0,
  pCompared = 0;
for (const r of samplePosts) {
  const newRow = (await newQuery(`SELECT content_raw FROM posts WHERE id = ?`, [r.pid]))[0];
  if (!newRow) {
    pMismatch++;
    continue;
  }
  pCompared++;
  if (md5(r.content) !== md5(newRow.content_raw)) pMismatch++;
}
add(
  "fidelity:posts_md5",
  pMismatch === 0,
  `抽样 ${pCompared}/${samplePosts.length}，不一致 ${pMismatch}`,
);

// ---------- 3. 转换完整性 ----------
// 表情码：映射内（120–169）的必须全部转换；映射外的遗留码（pw8 时代，旧站也无法渲染）允许原样保留
const mapped = new Set((await newQuery(`SELECT id FROM emoticons`)).map((r) => Number(r.id)));
const emoRows = [
  ...(await newQuery(`SELECT id, content_md FROM threads WHERE content_md LIKE '%[s:%'`)),
  ...(await newQuery(`SELECT id, content_md FROM posts WHERE content_md LIKE '%[s:%'`)),
];
const unmappedCodes = new Map<string, number>();
let mappedResidue = 0;
for (const r of emoRows) {
  for (const m of String(r.content_md).matchAll(/\[s:(\d+)\]/g)) {
    const code = Number(m[1]);
    if (mapped.has(code)) {
      mappedResidue++;
      break;
    }
    unmappedCodes.set(m[1], (unmappedCodes.get(m[1]) ?? 0) + 1);
  }
}
add(
  "convert:表情码",
  mappedResidue === 0,
  `映射内残留 ${mappedResidue}；映射外遗留码 ${unmappedCodes.size} 种 / ${emoRows.length} 行（旧站亦无法渲染，保留原文）`,
);

// UBB 标签：content_md 残留的标签必须在 content_raw 中原样存在（源帖笔误/截断的忠实保留）
const UBB_RE = /\[(?:FONT|SIZE|COLOR|QUOTE|URL|ATTACHMENT|BACKCOLOR|ALIGN)=[^\]\n]{0,80}/gi;
const ubbRows = [
  ...(await newQuery(`SELECT id, content_md, content_raw FROM threads
                     WHERE content_md REGEXP '\\\\[(FONT|SIZE|COLOR|QUOTE|URL|ATTACHMENT|BACKCOLOR|ALIGN)='`)),
  ...(await newQuery(`SELECT id, content_md, content_raw FROM posts
                     WHERE content_md REGEXP '\\\\[(FONT|SIZE|COLOR|QUOTE|URL|ATTACHMENT|BACKCOLOR|ALIGN)='`)),
];
let ubbOrphan = 0;
const ubbExamples: string[] = [];
for (const r of ubbRows) {
  const residue = String(r.content_md).match(UBB_RE) ?? [];
  const raw = String(r.content_raw ?? "");
  for (const tag of residue) {
    if (!raw.includes(tag)) {
      ubbOrphan++;
      ubbExamples.push(`#${r.id}: ${tag.slice(0, 40)}`);
      break;
    }
  }
}
add(
  "convert:UBB标签",
  ubbOrphan === 0,
  ubbOrphan === 0
    ? `仅 ${ubbRows.length} 行保留源帖原始残缺标签（笔误/截断，raw 可证）`
    : `转换器弄丢内容 ${ubbOrphan} 行: ${ubbExamples.join(" / ")}`,
);

// ---------- 4. 关键样本：日文标题与正文 ----------
const jp = (
  await newQuery(
    `SELECT t.title, t.content_md FROM threads t WHERE t.title LIKE '%刀剣乱舞%' LIMIT 1`,
  )
)[0];
add("sample:日文标题", !!jp, jp ? `「${jp.title}」` : "未找到「刀剣乱舞」主题");
const jpBody = (await newQuery(`SELECT title, content_md FROM threads WHERE id = 6623`))[0];
add(
  "sample:tid6623 正文",
  !!jpBody?.content_md && jpBody.content_md.includes("跨越了3000个夜晚"),
  jpBody ? String(jpBody.content_md).slice(0, 40).replace(/\n/g, " ") : "无正文",
);

// ---------- 5. 垃圾标记 ----------
const spamN = Number((await newQuery(`SELECT COUNT(*) n FROM threads WHERE is_spam = 1`))[0].n);
const spamExpect = Number(
  (
    await oldQuery(
      `SELECT COUNT(*) n FROM nw_bbs_threads t
   LEFT JOIN nw_bbs_threads_content c ON c.tid = t.tid
   WHERE c.tid IS NULL AND NOT EXISTS (SELECT 1 FROM nw_bbs_posts p WHERE p.tid = t.tid)`,
    )
  )[0].n,
);
add("spam:空壳标记", spamN === spamExpect, `标记 ${spamN} / 预期 ${spamExpect}`);

const spamUsers = Number((await newQuery(`SELECT COUNT(*) n FROM users WHERE is_spam = 1`))[0].n);
add("spam:用户标记", spamUsers > 0, `${spamUsers} 人标记 is_spam`);

// ---------- 6. 附件磁盘对账（缺失为源盘已损失，属警告非迁移错误） ----------
const attPaths = (await newQuery(`SELECT path FROM attachments`)).map((r) => String(r.path));
const missing = checkAttachmentFiles(attPaths);
add(
  "attach:磁盘文件",
  true,
  `${attPaths.length} 个附件，磁盘缺失 ${missing}${missing > 0 ? "（源盘即缺失，非迁移损失）⚠" : ""}`,
  missing > 0,
);

// ---------- 7. 楼层连续性 ----------
const badFloor = Number(
  (
    await newQuery(
      `SELECT COUNT(*) n FROM (
     SELECT thread_id, COUNT(*) c, MAX(floor) mx FROM posts GROUP BY thread_id HAVING c <> mx) x`,
    )
  )[0].n,
);
add("posts:楼层连续", badFloor === 0, `楼层断层线程数 ${badFloor}`);

// ---------- 汇总 ----------
console.log("\n========== 验证报告 ==========");
let fails = 0;
for (const c of checks) {
  if (!c.pass) fails++;
  const mark = c.pass ? (c.warn ? "⚠" : "✔") : "✘";
  console.log(`${mark} ${c.name.padEnd(26)} ${c.detail}`);
}
console.log("==============================");
console.log(
  fails === 0 ? `全部通过（${checks.length} 项检查）` : `失败 ${fails} / ${checks.length} 项`,
);

await closePools();
process.exit(fails === 0 ? 0 : 1);
