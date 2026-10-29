import { newQuery } from "./db.js";
import { rewriteEmojiAlt, type EmojiMeta } from "./transform/emoji-alt.js";

/**
 * 旧帖表情 alt 回填（M10.9，设计稿 §2.8，站长 2026-10-29 追加）：
 * 把 `posts.body_md` 与 `post_gates.hidden_md` 里 `![任意alt](/emoji/{id}.{ext})` 的 alt
 * 改写为该 id 在 `emojis` 表里的**当前名称**（渲染完全不变——alt 不参与显示，只影响无障碍与语义）。
 *
 * · **可重复执行**：旧 50 枚导入时名称是占位（「旧表情 {id}」），站长在后台改名后再跑一次即刷新全站；
 *   alt 已等于当前名称的行/处自动跳过（幂等），孤儿引用（id 不存在或 ext 不一致）只报告不改写。
 * · 输出只含计数与 id，不含任何正文。
 * · `hidden_md` 只在迁移 / 离线工具里可写（硬约定 3b），web 运行时守卫不受影响。
 * · 范围：仅迁移来的旧帖（新帖由编辑器写入正确 alt）；私信不迁移、无表情。
 *
 * 运行：pnpm --filter @funwind/migration exec tsx src/backfill-emoji-alt.ts
 */

async function main() {
  const metas = await newQuery<{ id: number; ext: string; name: string }>(
    "SELECT id, ext, name FROM emojis",
  );
  const names = new Map<number, EmojiMeta>(metas.map((r) => [Number(r.id), r]));
  console.log(`[emoji-alt] emojis 表 ${names.size} 行（名称以库内当前值为准）`);
  if (names.size === 0) {
    console.error("[emoji-alt] emojis 表为空：请先完成迁移导入（pnpm migrate emoji）。");
    process.exit(1);
  }

  let scannedPosts = 0;
  let touchedPosts = 0;
  let changedInPosts = 0;
  let alreadyInPosts = 0;
  const orphanPosts = new Map<number, string[]>();

  const posts = await newQuery<{ id: number; body_md: string }>(
    "SELECT id, body_md FROM posts WHERE body_md LIKE '%/emoji/%'",
  );
  for (const p of posts) {
    scannedPosts++;
    const r = rewriteEmojiAlt(p.body_md, names);
    if (r.changed > 0) {
      await newQuery("UPDATE posts SET body_md = ? WHERE id = ?", [r.md, p.id]);
      touchedPosts++;
      changedInPosts += r.changed;
    }
    alreadyInPosts += r.alreadyCurrent;
    if (r.orphans.length > 0) orphanPosts.set(Number(p.id), r.orphans);
  }

  let scannedGates = 0;
  let touchedGates = 0;
  let changedInGates = 0;
  let alreadyInGates = 0;
  const orphanGates = new Map<number, string[]>();

  const gates = await newQuery<{ id: number; hidden_md: string }>(
    "SELECT id, hidden_md FROM post_gates WHERE hidden_md LIKE '%/emoji/%'",
  );
  for (const g of gates) {
    scannedGates++;
    const r = rewriteEmojiAlt(g.hidden_md, names);
    if (r.changed > 0) {
      await newQuery("UPDATE post_gates SET hidden_md = ? WHERE id = ?", [r.md, g.id]);
      touchedGates++;
      changedInGates += r.changed;
    }
    alreadyInGates += r.alreadyCurrent;
    if (r.orphans.length > 0) orphanGates.set(Number(g.id), r.orphans);
  }

  console.log(
    `[emoji-alt] 正文：扫描 ${scannedPosts} 帖，改写 ${touchedPosts} 帖共 ${changedInPosts} 处，` +
      `已一致跳过 ${alreadyInPosts} 处；隐藏正文：扫描 ${scannedGates} 段，改写 ${touchedGates} 段共 ${changedInGates} 处，` +
      `已一致跳过 ${alreadyInGates} 处。`,
  );
  const orphanTotal =
    [...orphanPosts.values()].flat().length + [...orphanGates.values()].flat().length;
  if (orphanTotal > 0) {
    console.warn(
      `[emoji-alt] 孤儿引用 ${orphanTotal} 处（只报告、不改写）：` +
        [...orphanPosts].map(([id, refs]) => `post#${id}: ${refs.join("、")}`).join("；") +
        [...orphanGates].map(([id, refs]) => `gate#${id}: ${refs.join("、")}`).join("；"),
    );
  } else {
    console.log("[emoji-alt] 无孤儿引用。");
  }
  console.log(
    "[emoji-alt] 完成。站长在后台改名后可再次运行刷新全站 alt（幂等，已一致的自动跳过）。",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[emoji-alt] 失败：", e);
  process.exit(1);
});
