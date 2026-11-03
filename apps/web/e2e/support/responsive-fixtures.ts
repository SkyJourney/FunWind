import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { withE2eDb, type Q } from "./db";
import { FIX } from "./fixtures";
import { PNG_1X1 } from "./images";
import { USERS } from "./session";
import { STORAGE_E2E } from "./storage";

export const LAYOUT_WIDTHS = [320, 375, 414, 768, 1024, 1440] as const;
export const LONG_ASCII = "ContinuousASCIIWithoutAnyBreakOpportunity0123456789".repeat(12);
export const LONG_FILE_NAME = `${"UnbrokenAttachmentFilename0123456789".repeat(6)}.txt`;
export const LONG_PNG_NAME = `${"UnbrokenBrandAssetFilename0123456789".repeat(6)}.png`;
export const LONG_INVALID_NAME = `${"UnbrokenInvalidAssetFilename0123456789".repeat(6)}.jpeg`;

export type BrandPoolKind = "logo" | "hero" | "decor";

export type BrandPoolState = {
  items: { file: string; name: string }[];
  active: string | null;
};

const BRAND_POOL_KEYS: Record<BrandPoolKind, string> = {
  logo: "site.logo",
  hero: "site.hero",
  decor: "site.decor",
};

export type LayoutThread = {
  id: number;
  first: number;
  reply: number;
  pendingReply: number;
  title: string;
};

type StoredFixture = { id: number; key: string; sha: string; body: Buffer; mime: string };

/** 独立 SQL 夹具只记录本次插入的主键；既不改种子内容，也不按共享号段或时间范围清理。 */
export class ResponsiveFixtures {
  readonly marker = `layout-${randomBytes(6).toString("hex")}`;
  readonly roleKey = `e2e-${this.marker}`;
  readonly roleDescription = `布局权限说明${"仅用于验证管理页长说明与操作按钮的边界。".repeat(12)}`;
  readonly emojiGroupName = `布局批量选择 ${this.marker}`;
  readonly threads: Partial<
    Record<"teamVisible" | "teamPending" | "publicVisible" | "publicPending", LayoutThread>
  > = {};
  forumId = 0;
  emojiGroupId = 0;
  private readonly threadIds: number[] = [];
  private readonly files: StoredFixture[] = [];
  private readonly sessionHashes: string[] = [];
  private readonly brandFiles = new Map<string, BrandPoolKind>();

  /** 40 字符连续 ASCII 名称含本夹具随机标记；不借用迁移池项或主题包容量。 */
  brandAssetNames(kind: BrandPoolKind): string[] {
    return ["A", "B"].map((suffix) =>
      `Layout${this.marker.replaceAll("-", "")}${kind}${suffix}`.padEnd(40, "X"),
    );
  }

  /** 品牌池只读快照；所有写入仍由页面的上传、设当前、移除动作维护缓存。 */
  async readBrandPool(kind: BrandPoolKind): Promise<BrandPoolState> {
    const [row] = await withE2eDb((q) =>
      q.query<{ valueJson: string }>(
        "SELECT CAST(value AS CHAR) AS valueJson FROM site_settings WHERE `key` = ?",
        [BRAND_POOL_KEYS[kind]],
      ),
    );
    return row ? (JSON.parse(row.valueJson) as BrandPoolState) : { items: [], active: null };
  }

  /** 按本次两个精确随机名称找回成功上传，即使跳转或断言失败也不会漏记磁盘文件。 */
  async trackBrandPoolFiles(kind: BrandPoolKind): Promise<BrandPoolState> {
    const pool = await this.readBrandPool(kind);
    const names = this.brandAssetNames(kind);
    for (const item of pool.items) {
      if (names.includes(item.name) && new RegExp(`^${kind}-[a-z0-9]+\\.png$`).test(item.file))
        this.brandFiles.set(item.file, kind);
    }
    return pool;
  }

  /** UI 移除确认不再登记后，精确回收品牌文件；绝不直接覆盖池 JSON 或删掉仍被引用的字节。 */
  async cleanupBrandFiles(kind: BrandPoolKind): Promise<void> {
    const pool = await this.trackBrandPoolFiles(kind);
    const remaining: string[] = [];
    for (const [file, fileKind] of this.brandFiles) {
      if (fileKind !== kind) continue;
      if (pool.items.some((item) => item.file === file)) {
        remaining.push(file);
        continue;
      }
      await rm(path.join(STORAGE_E2E, "site", file), { force: true });
      this.brandFiles.delete(file);
    }
    if (remaining.length) throw new Error(`品牌素材必须先由真实 UI 移除：${remaining.join(", ")}`);
  }

  /** 会话助手返回的令牌只在内存中哈希后登记，收尾时不删除其他 spec 的会话。 */
  trackSession(token: string): void {
    this.sessionHashes.push(createHash("sha256").update(token).digest("hex"));
  }

  /** 记录由合法后台上传产生的唯一文件，清理时先解除板块引用再删除对应记录和字节。 */
  async trackUploadedStorageKey(key: string): Promise<void> {
    const rows = await withE2eDb((q) =>
      q.query<{ id: number; sha: string; mime: string }>(
        "SELECT id, sha256 AS sha, mime FROM files WHERE storage_key = ?",
        [key],
      ),
    );
    const row = rows[0];
    if (!row) throw new Error(`找不到刚上传的 E2E 文件登记：${key}`);
    this.files.push({
      id: Number(row.id),
      key,
      sha: row.sha,
      mime: row.mime,
      body: Buffer.alloc(0),
    });
  }

  /** 附件仅在 e2e SQL 夹具内登记；生产读取仍经过现有附件出口和 /files 鉴权。 */
  async seed(): Promise<void> {
    try {
      await withE2eDb(async (q) => {
        await q.exec("START TRANSACTION");
        try {
          const teamFile = await this.addFile(
            q,
            Buffer.from(`${this.marker}:restricted`),
            "txt",
            "text/plain",
          );
          const publicFile = await this.addFile(
            q,
            Buffer.from(`${this.marker}:public`),
            "txt",
            "text/plain",
          );
          const png = await this.addFile(
            q,
            Buffer.concat([PNG_1X1, Buffer.from(this.marker)]),
            "png",
            "image/png",
          );
          this.threads.teamVisible = await this.addThread(q, FIX.teamForum.id, "visible", teamFile);
          this.threads.teamPending = await this.addThread(q, FIX.teamForum.id, "pending", teamFile);
          this.threads.publicVisible = await this.addThread(
            q,
            FIX.compose.id,
            "visible",
            publicFile,
          );
          this.threads.publicPending = await this.addThread(
            q,
            FIX.compose.id,
            "pending",
            publicFile,
          );

          const forum = await q.exec(
            "INSERT INTO forums (name, parent_id, path, depth, kind, read_policy, write_policy, review_policy, is_listed) VALUES (?, 0, '/', 1, 'forum', 'public', 'members', 'none', 0)",
            [`布局板块图 ${this.marker}`],
          );
          this.forumId = forum.insertId;
          await q.exec("UPDATE forums SET path = ? WHERE id = ?", [
            `/${this.forumId}/`,
            this.forumId,
          ]);
          const group = await q.exec(
            "INSERT INTO emoji_groups (name, sort, enabled, created_at, updated_at) VALUES (?, 9999, 1, NOW(), NOW())",
            [this.emojiGroupName],
          );
          this.emojiGroupId = group.insertId;
          await q.exec(
            "INSERT INTO emojis (group_id, name, keywords, ext, storage_key, width, height, sort, enabled, created_at, updated_at) VALUES (?, ?, ?, 'png', ?, 1, 1, 1, 1, NOW(), NOW())",
            [this.emojiGroupId, `布局表情 ${this.marker}`, "布局 批量选择 表格局部滚动", png.key],
          );
          await q.exec(
            "INSERT INTO roles (`key`, name, kind, description, is_public) VALUES (?, ?, 'custom', ?, 0)",
            [this.roleKey, "跨尺寸布局隔离角色", this.roleDescription],
          );
          // 该角色不绑定任何用户；不改变 admin、member 或 team 的真实权限。
          for (const [permission, scope] of [
            ["site.visit", 0],
            ["emoji.manage", 0],
            ["forum.moderate", FIX.teamForum.id],
          ] as const) {
            await q.exec(
              "INSERT INTO role_grants (role_key, permission_key, scope_id) VALUES (?, ?, ?)",
              [this.roleKey, permission, scope],
            );
          }
          await q.exec("COMMIT");
        } catch (error) {
          await q.exec("ROLLBACK");
          throw error;
        }
      });
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  /** 每个文件内容含随机标记，哈希唯一；磁盘和登记行同属本次夹具。 */
  private async addFile(q: Q, body: Buffer, ext: string, mime: string): Promise<StoredFixture> {
    const sha = createHash("sha256").update(body).digest("hex");
    const key = `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.${ext}`;
    const file: StoredFixture = { id: 0, key, sha, body, mime };
    this.files.push(file);
    await mkdir(path.dirname(path.join(STORAGE_E2E, key)), { recursive: true });
    await writeFile(path.join(STORAGE_E2E, key), body);
    const row = await q.exec(
      "INSERT INTO files (sha256, storage_key, size_bytes, mime, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())",
      [sha, key, body.length, mime, ext === "png" ? 1 : null, ext === "png" ? 1 : null],
    );
    file.id = row.insertId;
    return file;
  }

  /** 可见主题含一条可见回复和一条待审回复；待审主题同时覆盖首帖动作。 */
  private async addThread(
    q: Q,
    forumId: number,
    state: "visible" | "pending",
    file: StoredFixture,
  ): Promise<LayoutThread> {
    const title = `布局 ${forumId === FIX.teamForum.id ? "所辖" : "非所辖"} ${state} ${this.marker}`;
    const thread = await q.exec(
      "INSERT INTO threads (forum_id, author_id, title, state, created_at, last_posted_at, reply_count) VALUES (?, ?, ?, ?, NOW(), NOW(), 1)",
      [forumId, USERS.alice, title, state],
    );
    this.threadIds.push(thread.insertId);
    const postIds: number[] = [];
    for (const [index, postState] of [state, "visible", "pending"].entries()) {
      const post = await q.exec(
        "INSERT INTO posts (thread_id, floor, author_id, body_md, has_gate, state, created_at, edited_at) VALUES (?, ?, ?, ?, 0, ?, NOW(), NOW())",
        [
          thread.insertId,
          index + 1,
          index === 0 ? USERS.alice : USERS.xiaoyi,
          `布局正文 ${this.marker} 第 ${index + 1} 层\n\n${LONG_ASCII}\n\n普通段落结束。`,
          postState,
        ],
      );
      postIds.push(post.insertId);
      await q.exec(
        "INSERT INTO attachments (post_id, file_id, uploader_id, original_name, kind, created_at) VALUES (?, ?, ?, ?, 'download', NOW())",
        [post.insertId, file.id, index === 0 ? USERS.alice : USERS.xiaoyi, LONG_FILE_NAME],
      );
    }
    await q.exec(
      "UPDATE threads SET first_post_id = ?, last_post_id = ?, last_poster_id = ? WHERE id = ?",
      [postIds[0], postIds[1], USERS.xiaoyi, thread.insertId],
    );
    return {
      id: thread.insertId,
      first: postIds[0]!,
      reply: postIds[1]!,
      pendingReply: postIds[2]!,
      title,
    };
  }

  /** 无业务提交产生积分/通知；仅删除本夹具关联行，避免影响其他测试的计数或授权。 */
  async cleanup(): Promise<void> {
    await withE2eDb(async (q) => {
      for (const id of this.threadIds) {
        await q.exec(
          "DELETE FROM content_reviews WHERE post_id IN (SELECT id FROM posts WHERE thread_id = ?)",
          [id],
        );
        await q.exec(
          "DELETE FROM attachments WHERE post_id IN (SELECT id FROM posts WHERE thread_id = ?)",
          [id],
        );
        await q.exec("DELETE FROM posts WHERE thread_id = ?", [id]);
        await q.exec("DELETE FROM threads WHERE id = ?", [id]);
      }
      if (this.emojiGroupId) {
        await q.exec("DELETE FROM emojis WHERE group_id = ?", [this.emojiGroupId]);
        await q.exec("DELETE FROM emoji_groups WHERE id = ?", [this.emojiGroupId]);
      }
      if (this.forumId) {
        // 即使上传后页面断言失败，也按本夹具板块的实际引用回收文件，避免依赖截图或读取 src 成功。
        const uploaded = await q.query<{ id: number; key: string; sha: string; mime: string }>(
          "SELECT f.id, f.storage_key AS `key`, f.sha256 AS sha, f.mime FROM files f JOIN forums b ON b.icon_key = f.storage_key WHERE b.id = ?",
          [this.forumId],
        );
        for (const file of uploaded) {
          if (!this.files.some((existing) => existing.key === file.key))
            this.files.push({ ...file, id: Number(file.id), body: Buffer.alloc(0) });
        }
        await q.exec(
          "DELETE FROM audit_log WHERE target_type = 'forum' AND target_id = ? AND action IN ('admin.forum.icon', 'admin.forum.icon.remove')",
          [String(this.forumId)],
        );
        await q.exec("DELETE FROM forums WHERE id = ?", [this.forumId]);
      }
      await q.exec("DELETE FROM role_grants WHERE role_key = ?", [this.roleKey]);
      await q.exec("DELETE FROM roles WHERE `key` = ?", [this.roleKey]);
      for (const hash of this.sessionHashes)
        await q.exec("DELETE FROM sessions WHERE id = ?", [hash]);
      for (const file of this.files) {
        if (file.id)
          await q.exec("DELETE FROM files WHERE id = ? AND sha256 = ?", [file.id, file.sha]);
      }
    });
    for (const file of this.files) await rm(path.join(STORAGE_E2E, file.key), { force: true });
  }
}
