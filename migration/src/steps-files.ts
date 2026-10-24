/**
 * 文件管线步骤：把转换阶段收集到的、真正被引用的文件登记进新存储。
 * 必须在 users / content / badges 之后运行（它们负责把引用登记进 ctx.files），因此 run.ts 对这四个步骤成组运行。
 *
 * 做的事：补登记头像与勋章图 → 按 sha256 升序分配 files.id（保证重跑一致）→ 复制到 STORAGE_DIR →
 * 写 files / attachments → 回填 user_profiles.avatar_file_id 与 badges.icon_file_id。
 */
import { config } from "./config.js";
import { bumpAutoIncrement, newQuery, replaceAll } from "./db.js";
import { materialize, type CollectedFile } from "./lib/files.js";
import { head, type Step } from "./step-types.js";

/** 一次回填的批大小（CASE WHEN 语句的长度上限） */
const CHUNK = 500;

/** 把绝对路径缩成相对旧站目录的形式，报告里不出现本机路径 */
const rel = (abs: string) =>
  abs.startsWith(config.attachmentDir)
    ? abs.slice(config.attachmentDir.length + 1)
    : abs.startsWith(config.medalDir)
      ? `medal/${abs.slice(config.medalDir.length + 1)}`
      : abs;

export const filesStep: Step = {
  name: "files",
  async run(ctx) {
    const c = ctx.files;

    // 头像（uid 升序）与勋章图（badge id 升序）：登记顺序固定
    const avatarRefs: { userId: number; file: CollectedFile }[] = [];
    let avatarMissing = 0;
    for (const [userId, src] of [...ctx.avatarSources].sort((a, b) => a[0] - b[0])) {
      const file = c.addUnder(config.attachmentDir, src);
      if (file) avatarRefs.push({ userId, file });
      else avatarMissing++;
    }
    const iconRefs: { badgeId: number; file: CollectedFile }[] = [];
    let iconMissing = 0;
    for (const [badgeId, src] of [...ctx.badgeIcons].sort((a, b) => a[0] - b[0])) {
      const file = c.addUnder(config.medalDir, src);
      if (file) iconRefs.push({ badgeId, file });
      else iconMissing++;
    }

    // 分配 id：按 sha256 升序，与处理顺序无关
    const all = c.all();
    const idOf = new Map(all.map((f, i) => [f.sha256, i + 1]));
    const { copied, existing } = materialize(all, config.storageDir);

    await replaceAll(
      "files",
      ["id", "sha256", "storage_key", "size_bytes", "mime", "created_at"],
      all.map((f) => ({
        id: idOf.get(f.sha256)!,
        sha256: f.sha256,
        storage_key: f.storageKey,
        size_bytes: f.sizeBytes,
        mime: f.mime,
        created_at: ctx.asOf,
      })),
    );
    await bumpAutoIncrement("files");

    await replaceAll(
      "attachments",
      ["id", "post_id", "file_id", "uploader_id", "original_name", "downloads", "created_at"],
      ctx.attachments.map((a, i) => ({
        id: i + 1,
        post_id: a.postId,
        file_id: idOf.get(a.sha256)!,
        uploader_id: a.uploaderId,
        original_name: a.originalName,
        downloads: a.downloads,
        created_at: a.createdAt,
      })),
    );
    await bumpAutoIncrement("attachments");

    // 回填头像与勋章图（先清空，保证重跑时不遗留陈旧引用）
    await newQuery("UPDATE user_profiles SET avatar_file_id = NULL");
    for (let i = 0; i < avatarRefs.length; i += CHUNK) {
      const part = avatarRefs.slice(i, i + CHUNK);
      const cases = part.map(() => "WHEN ? THEN ?").join(" ");
      await newQuery(
        `UPDATE user_profiles SET avatar_file_id = CASE user_id ${cases} END
         WHERE user_id IN (${part.map(() => "?").join(",")})`,
        [
          ...part.flatMap((r) => [r.userId, idOf.get(r.file.sha256)!]),
          ...part.map((r) => r.userId),
        ],
      );
    }
    await newQuery("UPDATE badges SET icon_file_id = NULL");
    for (const r of iconRefs) {
      await newQuery("UPDATE badges SET icon_file_id = ? WHERE id = ?", [
        idOf.get(r.file.sha256)!,
        r.badgeId,
      ]);
    }

    const bytes = all.reduce((n, f) => n + f.sizeBytes, 0);
    const missing = [...c.missing].map(rel).sort();
    const s = ctx.report.section("文件（内容寻址存储）");
    s.line(
      `登记 ${all.length} 个文件（引用 ${c.referenceCount} 次，按 SHA-256 去重后省去 ${c.referenceCount - all.length} 份），合计 ${(bytes / 1024 / 1024).toFixed(1)}MB；` +
        `存储键为 ab/cd/<sha256>.<ext>，运行时经 /files/<storage_key> 提供。`,
    );
    s.bullets([
      `头像 ${avatarRefs.length} 个已回填 avatar_file_id（旧站路径存在但文件缺失 ${avatarMissing}）`,
      `勋章图 ${iconRefs.length} 个已回填 icon_file_id（缺失 ${iconMissing}）`,
      `附件 ${ctx.attachments.length} 条已写入（文件缺失而丢弃的附件见内容小节）`,
      `旧站磁盘上找不到的引用路径 ${missing.length} 个：${head(missing, 10) || "无"}`,
      `逃出源目录而被拒绝的路径 ${c.rejected.size} 个（数据里的 .. / 绝对路径 / 符号链接，已拒绝读取）：${head([...c.rejected].sort(), 10) || "无"}`,
    ]);
    return {
      rows: all.length + ctx.attachments.length,
      note: `${all.length} 文件（新复制 ${copied} / 已存在 ${existing}）`,
    };
  },
};
