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
    // 板块图（M9.5 §3.4.3）：fid 升序登记（forum/icon/{fid}.jpg，attachmentDir 之下）；原字节直存不重编码
    const forumIconRefs: { forumId: number; file: CollectedFile }[] = [];
    let forumIconMissing = 0;
    for (const [forumId, src] of [...ctx.forumIconSources].sort((a, b) => a[0] - b[0])) {
      const file = c.addUnder(config.attachmentDir, src);
      if (file) forumIconRefs.push({ forumId, file });
      else forumIconMissing++;
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
      [
        "id",
        "post_id",
        "gate_id",
        "file_id",
        "uploader_id",
        "original_name",
        "downloads",
        "created_at",
      ],
      ctx.attachments.map((a, i) => ({
        id: i + 1,
        post_id: a.postId,
        gate_id: a.gateId,
        file_id: idOf.get(a.sha256)!,
        uploader_id: a.uploaderId,
        original_name: a.originalName,
        downloads: a.downloads,
        created_at: a.createdAt,
      })),
    );
    await bumpAutoIncrement("attachments");

    // ── 正文引用收敛（M9.5 站长反馈的存量缺口）──
    // 旧站的「附件下载」与「正文贴图」是两套独立数据；新模型（M10.6d）语义是
    // 「文件被正文引用即不再作为下载附件」。迁移直映射没有做这个收敛，
    // 导致旧帖图片既在正文渲染、又重复出现在帖末下载列表（开发库存量 302 公开 + 32 门控）。
    // 收敛规则：download 行的 storage_key 出现在该帖公开正文 → 转 inline（gate_id=NULL）；
    // 出现在某门控隐藏正文 → 转 inline 且保留该门控归属（随帖可见性语义不变，绝不能删行——
    // 删了图片附件行，图片会因「无任何引用」变成全网 public）。
    {
      const { extractKeys } = await import("@funwind/content");
      const downloadRows = await newQuery<{
        id: number;
        post_id: number;
        gate_id: number | null;
        storage_key: string;
      }>(
        `SELECT a.id, a.post_id, a.gate_id, f.storage_key
         FROM attachments a JOIN files f ON f.id = a.file_id
         WHERE a.kind = 'download'`,
      );
      // 每帖正文引用集合
      const bodyRefs = new Map<number, Set<string>>();
      for (const r of await newQuery<{ id: number; body_md: string }>(
        "SELECT id, body_md FROM posts",
      )) {
        const keys = extractKeys(r.body_md ?? "");
        if (keys.length > 0) bodyRefs.set(r.id, new Set(keys));
      }
      // 门控隐藏正文引用：gate_id → 集合
      const gateRefs = new Map<number, Set<string>>();
      for (const r of await newQuery<{ id: number; hidden_md: string }>(
        "SELECT id, hidden_md FROM post_gates",
      )) {
        const keys = extractKeys(r.hidden_md ?? "");
        if (keys.length > 0) gateRefs.set(r.id, new Set(keys));
      }
      let toInlinePublic = 0;
      let toInlineGated = 0;
      for (const row of downloadRows) {
        const inBody = bodyRefs.get(row.post_id)?.has(row.storage_key) ?? false;
        const inGate =
          row.gate_id !== null && (gateRefs.get(row.gate_id)?.has(row.storage_key) ?? false);
        if (!inBody && !inGate) continue;
        // 公开正文引用优先（gate_id 置 NULL）；仅在门控隐藏正文引用时保留门控归属
        const newGate = inBody ? null : row.gate_id;
        await newQuery("UPDATE attachments SET kind = 'inline', gate_id = ? WHERE id = ?", [
          newGate,
          row.id,
        ]);
        if (inBody) toInlinePublic += 1;
        else toInlineGated += 1;
      }
      ctx.report
        .section("附件引用收敛")
        .line(
          `download ${downloadRows.length} 行中：被公开正文引用 ${toInlinePublic} 行 → 转 inline（gate_id=NULL）；` +
            `仅被门控隐藏正文引用 ${toInlineGated} 行 → 转 inline（保留门控归属）。` +
            `未收敛 ${downloadRows.length - toInlinePublic - toInlineGated} 行保持 download。`,
        );
    }

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
    // 板块图回填（M9.5 §3.4.3）：icon_key 已非 NULL 不覆盖（保护后台改动）；NULL 才写入
    await newQuery("UPDATE forums SET icon_key = NULL WHERE icon_key IS NULL OR icon_key = ''");
    for (const r of forumIconRefs) {
      await newQuery("UPDATE forums SET icon_key = ? WHERE id = ? AND icon_key IS NULL", [
        r.file.storageKey,
        r.forumId,
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
      `板块图 ${forumIconRefs.length} 枚已回填 icon_key（缺失 ${forumIconMissing}；原字节直存不重编码）`,
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
