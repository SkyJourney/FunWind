import { newQuery, oldQuery, closePools } from "./db.js";
import { loadSchemaOnce } from "./schema-init.js";
import { emoticons as emoticonEnt, groups, forums, topicTypes } from "./entities/basic.js";
import { makeUsers } from "./entities/users.js";
import { makeThreads, makePosts } from "./entities/threads.js";
import { attachments, medals, credits, polls, messages } from "./entities/extra.js";
import { upsertBatch } from "./db.js";
import { toDatetime } from "./config.js";

export interface EmoCtx {
  emoticons: Map<number, { folder: string; icon: string }>;
  resolveAttachment: (aid: number) => { name: string; path: string } | null;
}

export interface Migrator {
  name: string;
  run: () => Promise<{ rows: number; note?: string }>;
}

async function loadEmoCtx(): Promise<EmoCtx> {
  const emoticons = new Map<number, { folder: string; icon: string }>();
  for (const r of await oldQuery(
    `SELECT emotion_id, emotion_folder, emotion_icon FROM nw_common_emotion`,
  )) {
    emoticons.set(Number(r.emotion_id), { folder: r.emotion_folder, icon: r.emotion_icon });
  }
  const atts = new Map<number, { name: string; path: string }>();
  for (const r of await oldQuery(`SELECT aid, name, path FROM nw_attachs_thread`)) {
    atts.set(Number(r.aid), { name: r.name, path: r.path });
  }
  return { emoticons, resolveAttachment: (aid) => atts.get(aid) ?? null };
}

const emo = await loadEmoCtx();

// 执行顺序：依赖无关（UPSERT + 保留旧主键），但按可读性排列
const ALL: Migrator[] = [
  emoticonEnt,
  groups,
  forums,
  topicTypes,
  makeUsers(emo),
  makeThreads(emo),
  makePosts(emo),
  attachments,
  medals,
  credits,
  polls,
  messages,
];

const only = process.argv.slice(2);
const list = only.length > 0 ? ALL.filter((m) => only.includes(m.name)) : ALL;
if (list.length === 0) {
  console.error(`未找到实体: ${only.join(",")}。可选: ${ALL.map((m) => m.name).join(" ")}`);
  process.exit(1);
}

await loadSchemaOnce();

// 并发锁（基线审查 P3）：GET_LOCK 会话级互斥，双开即拒；进程退出（连接关闭）自动释放
const lockRows = await newQuery<{ got: number }>(
  "SELECT GET_LOCK('qysub_migration_run', 0) AS got",
);
if (Number(lockRows[0]?.got) !== 1) {
  console.error("✘ 已有迁移进程在运行（GET_LOCK 'qysub_migration_run' 被占用），拒绝并发执行。");
  await closePools();
  process.exit(1);
}

let failed = 0;
for (const m of list) {
  const t0 = Date.now();
  try {
    const { rows, note } = await m.run();
    const ms = Date.now() - t0;
    await upsertBatch(
      "migration_state",
      ["entity", "rows_written", "duration_ms", "finished_at", "note"],
      [
        {
          entity: m.name,
          rows_written: rows,
          duration_ms: ms,
          finished_at: toDatetime(Math.floor(Date.now() / 1000)),
          note: note ?? "",
        },
      ],
      ["entity"],
    );
    console.log(`✔ ${m.name.padEnd(18)} ${String(rows).padStart(7)} 行  ${ms}ms  ${note ?? ""}`);
  } catch (e) {
    failed++;
    console.error(`✘ ${m.name}: ${e instanceof Error ? e.message : e}`);
  }
}

await closePools();
if (failed > 0) {
  console.error(`\n${failed} 个实体失败，已完成的实体状态保留，修复后可重跑（幂等）。`);
  process.exit(1);
}
console.log(`\n全部完成：${list.length} 个实体。重跑安全（UPSERT + 旧主键保留）。`);
