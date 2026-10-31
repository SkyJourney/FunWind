"use server";

import { defineAction } from "@/lib/actions/define-action";
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect, notFound } from "next/navigation";
import { emojiGroups, emojis, files, getWebDb, insertIdOf } from "@funwind/db";
import { writeAudit, type DbTx } from "@/lib/audit";
import { isDuplicateKey } from "@/lib/auth/register";
import { getStorageDir } from "@/lib/storage";
import { processEmojiUpload } from "@/lib/emoji/admin";

/**
 * 社区表情管理动作（M10.9，设计稿 §2.5）：门禁 emoji.manage（admin 默认持有）；
 * 所有变更与 audit_log 同事务（不存在改了表情却没留痕的窗口）。
 * 排序动作实现为列表全量重排（sort = 1..n），避免默认值 0 的并列无法交换；
 * 停用只影响面板，已发布正文里的 /emoji/{id}.{ext} 引用永远可渲染（提供路由不检查 enabled）。
 * 上传的上限与格式校验在 lib/emoji/admin.ts（≤200×200、≤200KB、png/gif/webp）；
 * 表情不写 file_uploads、不占用户配额（files 表只做内容登记，供 gc 巡检识别）。
 */

const back = z.string().max(200).default("/admin/emojis");

async function lockEmojiGroup(tx: DbTx, id: number) {
  const [group] = await tx
    .select()
    .from(emojiGroups)
    .where(eq(emojiGroups.id, id))
    .limit(1)
    .for("update");
  return group;
}

/** 组内排序/上传统一先锁组行，避免并发动作以不同顺序争抢表情行。 */
async function lockGroupEmojiRows(tx: DbTx, groupId: number) {
  return tx
    .select({ id: emojis.id, sort: emojis.sort })
    .from(emojis)
    .where(eq(emojis.groupId, groupId))
    .orderBy(asc(emojis.sort), asc(emojis.id))
    .for("update");
}

/** 上传文件 → 默认表情名：文件名去扩展、截到列宽；空则占位「新表情」 */
function defaultEmojiName(fileName: string): string {
  const base = fileName
    .replace(/\.[a-z0-9]+$/i, "")
    .trim()
    .slice(0, 50);
  return base || "新表情";
}

export const createGroupAction = defineAction({
  name: "admin.emoji.group.create",
  auth: { admin: "emoji.manage" },
  input: z.object({
    name: z.string().trim().min(1, "分组名不能为空").max(50),
    back,
  }),
  async run(ctx, input) {
    try {
      await getWebDb().transaction(async (tx) => {
        const id = insertIdOf(
          await tx.insert(emojiGroups).values({
            name: input.name,
            sort: 0,
            createdAt: sql`NOW()`,
            updatedAt: sql`NOW()`,
          }),
        );
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: "admin.emoji.group.create",
          targetType: "emoji_group",
          targetId: id,
          after: { name: input.name, via: "admin" },
          ip: ctx.ip,
        });
      });
    } catch (error) {
      if (isDuplicateKey(error)) redirect(`${input.back}?err=name-exists`);
      throw error;
    }
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?saved=group-created`);
  },
});

export const uploadGroupIconAction = defineAction({
  name: "admin.emoji.group.icon",
  auth: { admin: "emoji.manage" },
  input: z.object({
    id: z.coerce.number().int().positive(),
    /** 分组标题图（独立上传，站长 2026-10-29 拍板）：同表情管线校验（≤200×200、≤200KB、png/gif/webp） */
    icon: z.instanceof(File),
    back,
  }),
  async run(ctx, input) {
    const [group] = await getWebDb()
      .select({ id: emojiGroups.id })
      .from(emojiGroups)
      .where(eq(emojiGroups.id, input.id))
      .limit(1);
    if (!group) notFound();
    const bytes = Buffer.from(await input.icon.arrayBuffer());
    const r = await processEmojiUpload(bytes, getStorageDir());
    if (!r.ok) {
      redirect(
        `${input.back}?group=${group.id}&err=${r.code}&name=${encodeURIComponent(input.icon.name)}`,
      );
    }
    await getWebDb().transaction(async (tx) => {
      const current = await lockEmojiGroup(tx, input.id);
      if (!current) notFound();
      // files 表只做内容登记（同 sha 去重）；不写 file_uploads、不占用户配额
      await tx
        .insert(files)
        .ignore()
        .values({
          sha256: r.sha256,
          storageKey: r.storageKey,
          sizeBytes: r.sizeBytes,
          mime: r.mime,
          width: r.width,
          height: r.height,
          createdAt: sql`NOW()`,
        });
      const [fileRow] = await tx
        .select({ id: files.id })
        .from(files)
        .where(eq(files.sha256, r.sha256))
        .limit(1);
      await tx
        .update(emojiGroups)
        .set({ iconKey: r.storageKey, updatedAt: sql`NOW()` })
        .where(eq(emojiGroups.id, input.id));
      await writeAudit(tx, {
        actorId: ctx.userId,
        action: "admin.emoji.group.icon",
        targetType: "emoji_group",
        targetId: input.id,
        before: { iconKey: current.iconKey },
        after: { iconKey: r.storageKey, fileId: fileRow?.id, via: "admin" },
        ip: ctx.ip,
      });
    });
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?group=${group.id}&saved=group-icon`);
  },
});

export const renameGroupAction = defineAction({
  name: "admin.emoji.group.rename",
  auth: { admin: "emoji.manage" },
  input: z.object({
    id: z.coerce.number().int().positive(),
    name: z.string().trim().min(1).max(50),
    back,
  }),
  async run(ctx, input) {
    let result: "missing" | "name-exists" | "unchanged" | "renamed";
    try {
      result = await getWebDb().transaction(async (tx) => {
        const before = await lockEmojiGroup(tx, input.id);
        if (!before) return "missing";
        if (before.name === input.name) return "unchanged";
        const [clash] = await tx
          .select({ id: emojiGroups.id })
          .from(emojiGroups)
          .where(eq(emojiGroups.name, input.name))
          .limit(1);
        if (clash) return "name-exists";
        await tx
          .update(emojiGroups)
          .set({ name: input.name, updatedAt: sql`NOW()` })
          .where(eq(emojiGroups.id, input.id));
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: "admin.emoji.group.rename",
          targetType: "emoji_group",
          targetId: input.id,
          before: { name: before.name },
          after: { name: input.name, via: "admin" },
          ip: ctx.ip,
        });
        return "renamed";
      });
    } catch (error) {
      if (isDuplicateKey(error)) redirect(`${input.back}?err=name-exists`);
      throw error;
    }
    if (result === "missing") notFound();
    if (result === "name-exists") redirect(`${input.back}?err=name-exists`);
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?saved=group-renamed`);
  },
});

export const toggleGroupAction = defineAction({
  name: "admin.emoji.group.toggle",
  auth: { admin: "emoji.manage" },
  input: z.object({ id: z.coerce.number().int().positive(), enabled: z.enum(["0", "1"]), back }),
  async run(ctx, input) {
    const enabled = input.enabled === "1";
    const groupId = await getWebDb().transaction(async (tx) => {
      const before = await lockEmojiGroup(tx, input.id);
      if (!before) return null;
      if (before.enabled === enabled) return before.id;
      await tx
        .update(emojiGroups)
        .set({ enabled, updatedAt: sql`NOW()` })
        .where(eq(emojiGroups.id, input.id));
      await writeAudit(tx, {
        actorId: ctx.userId,
        action: "admin.emoji.group.toggle",
        targetType: "emoji_group",
        targetId: input.id,
        before: { enabled: before.enabled },
        after: { enabled, via: "admin" },
        ip: ctx.ip,
      });
      return before.id;
    });
    if (groupId === null) notFound();
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?saved=group-toggled`);
  },
});

export const deleteGroupAction = defineAction({
  name: "admin.emoji.group.delete",
  auth: { admin: "emoji.manage" },
  input: z.object({ id: z.coerce.number().int().positive(), back }),
  async run(ctx, input) {
    const result = await getWebDb().transaction(async (tx) => {
      const before = await lockEmojiGroup(tx, input.id);
      if (!before) return "missing";
      const [{ n }] = await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(emojis)
        .where(eq(emojis.groupId, input.id));
      // 与板块「有内容仅归档」同一保护思路：组内还有表情就不允许删。
      if (Number(n) > 0) return "not-empty";
      await tx.delete(emojiGroups).where(eq(emojiGroups.id, input.id));
      await writeAudit(tx, {
        actorId: ctx.userId,
        action: "admin.emoji.group.delete",
        targetType: "emoji_group",
        targetId: input.id,
        before: { name: before.name, sort: before.sort },
        ip: ctx.ip,
      });
      return "deleted";
    });
    if (result === "missing") notFound();
    if (result === "not-empty") redirect(`${input.back}?err=group-not-empty`);
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?saved=group-deleted`);
  },
});

export const moveGroupAction = defineAction({
  name: "admin.emoji.group.move",
  auth: { admin: "emoji.manage" },
  input: z.object({ id: z.coerce.number().int().positive(), dir: z.enum(["up", "down"]), back }),
  async run(ctx, input) {
    const result = await getWebDb().transaction(async (tx) => {
      const rows = await tx
        .select({ id: emojiGroups.id, sort: emojiGroups.sort })
        .from(emojiGroups)
        .orderBy(asc(emojiGroups.sort), asc(emojiGroups.id))
        .for("update");
      const from = rows.findIndex((row) => row.id === input.id);
      if (from < 0) return "missing";
      const to = input.dir === "up" ? from - 1 : from + 1;
      if (to < 0 || to >= rows.length) return "unchanged";
      const ordered = [...rows];
      const [moved] = ordered.splice(from, 1);
      if (!moved) return "missing";
      ordered.splice(to, 0, moved);
      for (let i = 0; i < ordered.length; i++) {
        const row = ordered[i]!;
        if (row.sort === i + 1) continue;
        await tx
          .update(emojiGroups)
          .set({ sort: i + 1, updatedAt: sql`NOW()` })
          .where(eq(emojiGroups.id, row.id));
      }
      await writeAudit(tx, {
        actorId: ctx.userId,
        action: "admin.emoji.group.move",
        targetType: "emoji_group",
        targetId: input.id,
        before: { order: rows.map(({ id, sort }) => ({ id, sort })) },
        after: {
          order: ordered.map(({ id }, index) => ({ id, sort: index + 1 })),
          dir: input.dir,
          via: "admin",
        },
        ip: ctx.ip,
      });
      return "moved";
    });
    if (result === "missing") notFound();
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?saved=group-moved`);
  },
});

/** 单文件时 formDataToObject 给标量 File，多文件给数组——这里归一化成数组再交给 z.array */
const fileList = z.preprocess(
  (v) => (Array.isArray(v) ? v : [v]),
  z.array(z.instanceof(File)).min(1).max(20),
);

export const uploadEmojiAction = defineAction({
  name: "admin.emoji.upload",
  auth: { admin: "emoji.manage" },
  input: z.object({
    groupId: z.coerce.number().int().positive(),
    /** 单次最多 20 个文件：后台表单的实用上限，防一次提交塞爆内存 */
    files: fileList,
    back,
  }),
  async run(ctx, input) {
    const [group] = await getWebDb()
      .select({ id: emojiGroups.id })
      .from(emojiGroups)
      .where(eq(emojiGroups.id, input.groupId))
      .limit(1);
    if (!group) notFound();

    // 逐文件处理（M9.5 部分成功语义）：成功的入库，失败收集明细随回跳展示——一张不合格不拖累其余
    const processed: {
      result: Exclude<Awaited<ReturnType<typeof processEmojiUpload>>, { ok: false }>;
      name: string;
    }[] = [];
    const failed: string[] = [];
    for (const f of input.files) {
      const bytes = Buffer.from(await f.arrayBuffer());
      const r = await processEmojiUpload(bytes, getStorageDir());
      if (!r.ok) {
        failed.push(`${f.name}：${r.code}`);
        continue;
      }
      processed.push({ result: r, name: defaultEmojiName(f.name) });
    }
    if (processed.length === 0) {
      // 全部失败：沿用单条错误展示
      redirect(
        `${input.back}?group=${group.id}&err=${encodeURIComponent(failed[0]?.split("：")[1] ?? "empty")}&name=${encodeURIComponent(failed[0]?.split("：")[0] ?? "")}`,
      );
    }

    await getWebDb().transaction(async (tx) => {
      const current = await lockEmojiGroup(tx, group.id);
      if (!current) notFound();
      for (const { result: p, name } of processed) {
        // files 表按 sha 去重登记（同内容可建多个名字）；不写 file_uploads（表情不占用户配额）
        await tx
          .insert(files)
          .ignore()
          .values({
            sha256: p.sha256,
            storageKey: p.storageKey,
            sizeBytes: p.sizeBytes,
            mime: p.mime,
            width: p.width,
            height: p.height,
            createdAt: sql`NOW()`,
          });
        const [fileRow] = await tx
          .select({ id: files.id })
          .from(files)
          .where(eq(files.sha256, p.sha256))
          .limit(1);
        const [{ maxSort }] = await tx
          .select({ maxSort: sql<number>`COALESCE(MAX(${emojis.sort}), 0)` })
          .from(emojis)
          .where(eq(emojis.groupId, group.id));
        const id = insertIdOf(
          await tx.insert(emojis).values({
            groupId: group.id,
            name,
            ext: p.ext,
            storageKey: p.storageKey,
            width: p.width,
            height: p.height,
            sort: Number(maxSort) + 1,
            createdAt: sql`NOW()`,
            updatedAt: sql`NOW()`,
          }),
        );
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: "admin.emoji.upload",
          targetType: "emoji",
          targetId: id,
          after: {
            name,
            groupId: group.id,
            ext: p.ext,
            storageKey: p.storageKey,
            fileId: fileRow?.id,
            via: "admin",
          },
          ip: ctx.ip,
        });
      }
    });
    revalidatePath("/admin/emojis");
    const failedQ =
      failed.length > 0
        ? `&failed=${encodeURIComponent(failed.slice(0, 5).join("|"))}${failed.length > 5 ? `&failedMore=${failed.length - 5}` : ""}`
        : "";
    redirect(`${input.back}?group=${group.id}&saved=upload&uploaded=${processed.length}${failedQ}`);
  },
});

export const updateEmojiAction = defineAction({
  name: "admin.emoji.update",
  auth: { admin: "emoji.manage" },
  input: z.object({
    id: z.coerce.number().int().positive(),
    name: z.string().trim().min(1, "名称不能为空").max(50),
    keywords: z.string().trim().max(200).default(""),
    /** 排序值（M9.5 数字输入范式，替代逐位 ↑↓）：0–9999，同组内升序在前 */
    sort: z.coerce.number().int().min(0).max(9999),
    back,
  }),
  async run(ctx, input) {
    const [probe] = await getWebDb()
      .select({ groupId: emojis.groupId })
      .from(emojis)
      .where(eq(emojis.id, input.id))
      .limit(1);
    if (!probe) notFound();
    const groupId = await getWebDb().transaction(async (tx) => {
      const group = await lockEmojiGroup(tx, probe.groupId);
      if (!group) return null;
      const [before] = await tx
        .select()
        .from(emojis)
        .where(eq(emojis.id, input.id))
        .limit(1)
        .for("update");
      if (!before) return null;
      if (
        before.name !== input.name ||
        before.keywords !== input.keywords ||
        before.sort !== input.sort
      ) {
        await tx
          .update(emojis)
          .set({
            name: input.name,
            keywords: input.keywords,
            sort: input.sort,
            updatedAt: sql`NOW()`,
          })
          .where(eq(emojis.id, input.id));
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: "admin.emoji.update",
          targetType: "emoji",
          targetId: input.id,
          before: { name: before.name, keywords: before.keywords, sort: before.sort },
          after: { name: input.name, keywords: input.keywords, sort: input.sort, via: "admin" },
          ip: ctx.ip,
        });
      }
      return before.groupId;
    });
    if (groupId === null) notFound();
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?group=${groupId}&saved=emoji-renamed`);
  },
});

export const moveEmojiAction = defineAction({
  name: "admin.emoji.move",
  auth: { admin: "emoji.manage" },
  input: z.object({ id: z.coerce.number().int().positive(), dir: z.enum(["up", "down"]), back }),
  async run(ctx, input) {
    const [probe] = await getWebDb()
      .select({ groupId: emojis.groupId })
      .from(emojis)
      .where(eq(emojis.id, input.id))
      .limit(1);
    if (!probe) notFound();
    const result = await getWebDb().transaction(async (tx) => {
      const group = await lockEmojiGroup(tx, probe.groupId);
      if (!group) return { kind: "missing" as const, groupId: probe.groupId };
      const rows = await lockGroupEmojiRows(tx, group.id);
      const from = rows.findIndex((row) => row.id === input.id);
      if (from < 0) return { kind: "missing" as const, groupId: group.id };
      const to = input.dir === "up" ? from - 1 : from + 1;
      if (to < 0 || to >= rows.length) return { kind: "unchanged" as const, groupId: group.id };
      const ordered = [...rows];
      const [moved] = ordered.splice(from, 1);
      if (!moved) return { kind: "missing" as const, groupId: group.id };
      ordered.splice(to, 0, moved);
      for (let i = 0; i < ordered.length; i++) {
        const row = ordered[i]!;
        if (row.sort === i + 1) continue;
        await tx
          .update(emojis)
          .set({ sort: i + 1, updatedAt: sql`NOW()` })
          .where(eq(emojis.id, row.id));
      }
      await writeAudit(tx, {
        actorId: ctx.userId,
        action: "admin.emoji.move",
        targetType: "emoji",
        targetId: input.id,
        before: { order: rows.map(({ id, sort }) => ({ id, sort })) },
        after: {
          order: ordered.map(({ id }, index) => ({ id, sort: index + 1 })),
          dir: input.dir,
          groupId: group.id,
          via: "admin",
        },
        ip: ctx.ip,
      });
      return { kind: "moved" as const, groupId: group.id };
    });
    if (result.kind === "missing") notFound();
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?group=${result.groupId}&saved=emoji-moved`);
  },
});

export const toggleEmojiAction = defineAction({
  name: "admin.emoji.toggle",
  auth: { admin: "emoji.manage" },
  input: z.object({ id: z.coerce.number().int().positive(), enabled: z.enum(["0", "1"]), back }),
  async run(ctx, input) {
    const enabled = input.enabled === "1";
    const groupId = await getWebDb().transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(emojis)
        .where(eq(emojis.id, input.id))
        .limit(1)
        .for("update");
      if (!before) return null;
      if (before.enabled !== enabled) {
        await tx
          .update(emojis)
          .set({ enabled, updatedAt: sql`NOW()` })
          .where(eq(emojis.id, input.id));
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: "admin.emoji.toggle",
          targetType: "emoji",
          targetId: input.id,
          before: { enabled: before.enabled },
          after: { enabled, via: "admin" },
          ip: ctx.ip,
        });
      }
      return before.groupId;
    });
    if (groupId === null) notFound();
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?group=${groupId}&saved=emoji-toggled`);
  },
});

/** 分组排序（M9.5 数字输入范式）：直接改 sort 值，展示按 (sort, id) 升序 */
export const reorderGroupAction = defineAction({
  name: "admin.emoji.group.reorder",
  auth: { admin: "emoji.manage" },
  input: z.object({
    id: z.coerce.number().int().positive(),
    sort: z.coerce.number().int().min(0).max(9999),
    back,
  }),
  async run(ctx, input) {
    const found = await getWebDb().transaction(async (tx) => {
      const before = await lockEmojiGroup(tx, input.id);
      if (!before) return false;
      if (before.sort !== input.sort) {
        await tx
          .update(emojiGroups)
          .set({ sort: input.sort, updatedAt: sql`NOW()` })
          .where(eq(emojiGroups.id, input.id));
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: "admin.emoji.group.reorder",
          targetType: "emoji_group",
          targetId: input.id,
          before: { sort: before.sort },
          after: { sort: input.sort, via: "admin" },
          ip: ctx.ip,
        });
      }
      return true;
    });
    if (!found) notFound();
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?saved=group-moved`);
  },
});
