"use server";

import { defineAction } from "@/lib/actions/define-action";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect, notFound } from "next/navigation";
import { emojiGroups, emojis, files, getWebDb } from "@funwind/db";
import { writeAudit } from "@/lib/audit";
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
    const exists = await getWebDb()
      .select({ id: emojiGroups.id })
      .from(emojiGroups)
      .where(eq(emojiGroups.name, input.name))
      .limit(1);
    if (exists.length > 0) redirect(`${input.back}?err=name-exists`);
    await getWebDb().transaction(async (tx) => {
      const [ins] = (await tx.insert(emojiGroups).values({
        name: input.name,
        sort: 0,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })) as unknown as [{ insertId: number }];
      await writeAudit(tx, {
        actorId: ctx.userId,
        action: "admin.emoji.group.create",
        targetType: "emoji_group",
        targetId: ins.insertId,
        after: { name: input.name, via: "admin" },
        ip: ctx.ip,
      });
    });
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
      .select()
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
        before: { iconKey: group.iconKey },
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
    const [before] = await getWebDb()
      .select()
      .from(emojiGroups)
      .where(eq(emojiGroups.id, input.id))
      .limit(1);
    if (!before) notFound();
    if (before.name !== input.name) {
      const clash = await getWebDb()
        .select({ id: emojiGroups.id })
        .from(emojiGroups)
        .where(eq(emojiGroups.name, input.name))
        .limit(1);
      if (clash.length > 0) redirect(`${input.back}?err=name-exists`);
      await getWebDb().transaction(async (tx) => {
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
      });
    }
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
    const [before] = await getWebDb()
      .select()
      .from(emojiGroups)
      .where(eq(emojiGroups.id, input.id))
      .limit(1);
    if (!before) notFound();
    if (before.enabled !== enabled) {
      await getWebDb().transaction(async (tx) => {
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
      });
    }
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?saved=group-toggled`);
  },
});

export const deleteGroupAction = defineAction({
  name: "admin.emoji.group.delete",
  auth: { admin: "emoji.manage" },
  input: z.object({ id: z.coerce.number().int().positive(), back }),
  async run(ctx, input) {
    const [before] = await getWebDb()
      .select()
      .from(emojiGroups)
      .where(eq(emojiGroups.id, input.id))
      .limit(1);
    if (!before) notFound();
    const [{ n }] = await getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(emojis)
      .where(eq(emojis.groupId, input.id));
    // 与板块「有内容仅归档」同一保护思路：组内还有表情就不允许删（表情不做物理删除，组只能空了再删）
    if (Number(n) > 0) redirect(`${input.back}?err=group-not-empty`);
    await getWebDb().transaction(async (tx) => {
      await tx.delete(emojiGroups).where(eq(emojiGroups.id, input.id));
      await writeAudit(tx, {
        actorId: ctx.userId,
        action: "admin.emoji.group.delete",
        targetType: "emoji_group",
        targetId: input.id,
        before: { name: before.name, sort: before.sort },
        ip: ctx.ip,
      });
    });
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?saved=group-deleted`);
  },
});

export const moveGroupAction = defineAction({
  name: "admin.emoji.group.move",
  auth: { admin: "emoji.manage" },
  input: z.object({ id: z.coerce.number().int().positive(), dir: z.enum(["up", "down"]), back }),
  async run(ctx, input) {
    const rows = await getWebDb()
      .select({ id: emojiGroups.id, sort: emojiGroups.sort })
      .from(emojiGroups);
    const from = rows.findIndex((r) => r.id === input.id);
    if (from < 0) notFound();
    const to = input.dir === "up" ? from - 1 : from + 1;
    if (to < 0 || to >= rows.length) {
      redirect(`${input.back}?saved=group-moved`); // 已在端头：无动作，仍回页面
    }
    const ordered = [...rows].sort((a, b) => a.sort - b.sort || a.id - b.id);
    const [moved] = ordered.splice(from, 1);
    if (!moved) notFound();
    ordered.splice(to, 0, moved);
    await getWebDb().transaction(async (tx) => {
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
        after: { dir: input.dir, via: "admin" },
        ip: ctx.ip,
      });
    });
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

    // 全部处理成功才入库：任一超限 / 格式不符即整批退回（带首个失败的文件名），避免「传一半」的困惑
    const processed: {
      result: Exclude<Awaited<ReturnType<typeof processEmojiUpload>>, { ok: false }>;
      name: string;
    }[] = [];
    for (const f of input.files) {
      const bytes = Buffer.from(await f.arrayBuffer());
      const r = await processEmojiUpload(bytes, getStorageDir());
      if (!r.ok) {
        redirect(
          `${input.back}?group=${group.id}&err=${r.code}&name=${encodeURIComponent(f.name)}`,
        );
      }
      processed.push({ result: r, name: defaultEmojiName(f.name) });
    }

    await getWebDb().transaction(async (tx) => {
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
        const [ins] = (await tx.insert(emojis).values({
          groupId: group.id,
          name,
          ext: p.ext,
          storageKey: p.storageKey,
          width: p.width,
          height: p.height,
          sort: Number(maxSort) + 1,
          createdAt: sql`NOW()`,
          updatedAt: sql`NOW()`,
        })) as unknown as [{ insertId: number }];
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: "admin.emoji.upload",
          targetType: "emoji",
          targetId: ins.insertId,
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
    redirect(`${input.back}?group=${group.id}&saved=upload`);
  },
});

export const updateEmojiAction = defineAction({
  name: "admin.emoji.rename",
  auth: { admin: "emoji.manage" },
  input: z.object({
    id: z.coerce.number().int().positive(),
    name: z.string().trim().min(1, "名称不能为空").max(50),
    keywords: z.string().trim().max(200).default(""),
    back,
  }),
  async run(ctx, input) {
    const [before] = await getWebDb().select().from(emojis).where(eq(emojis.id, input.id)).limit(1);
    if (!before) notFound();
    if (before.name !== input.name || before.keywords !== input.keywords) {
      await getWebDb().transaction(async (tx) => {
        await tx
          .update(emojis)
          .set({ name: input.name, keywords: input.keywords, updatedAt: sql`NOW()` })
          .where(eq(emojis.id, input.id));
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: "admin.emoji.rename",
          targetType: "emoji",
          targetId: input.id,
          before: { name: before.name, keywords: before.keywords },
          after: { name: input.name, keywords: input.keywords, via: "admin" },
          ip: ctx.ip,
        });
      });
    }
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?group=${before.groupId}&saved=emoji-renamed`);
  },
});

export const moveEmojiAction = defineAction({
  name: "admin.emoji.move",
  auth: { admin: "emoji.manage" },
  input: z.object({ id: z.coerce.number().int().positive(), dir: z.enum(["up", "down"]), back }),
  async run(ctx, input) {
    const [target] = await getWebDb().select().from(emojis).where(eq(emojis.id, input.id)).limit(1);
    if (!target) notFound();
    const rows = await getWebDb()
      .select({ id: emojis.id, sort: emojis.sort })
      .from(emojis)
      .where(eq(emojis.groupId, target.groupId));
    const from = rows.findIndex((r) => r.id === input.id);
    const to = input.dir === "up" ? from - 1 : from + 1;
    if (from >= 0 && to >= 0 && to < rows.length) {
      const ordered = [...rows].sort((a, b) => a.sort - b.sort || a.id - b.id);
      const [moved] = ordered.splice(from, 1);
      if (moved) {
        ordered.splice(to, 0, moved);
        await getWebDb().transaction(async (tx) => {
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
            after: { dir: input.dir, groupId: target.groupId, via: "admin" },
            ip: ctx.ip,
          });
        });
      }
    }
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?group=${target.groupId}&saved=emoji-moved`);
  },
});

export const toggleEmojiAction = defineAction({
  name: "admin.emoji.toggle",
  auth: { admin: "emoji.manage" },
  input: z.object({ id: z.coerce.number().int().positive(), enabled: z.enum(["0", "1"]), back }),
  async run(ctx, input) {
    const enabled = input.enabled === "1";
    const [before] = await getWebDb().select().from(emojis).where(eq(emojis.id, input.id)).limit(1);
    if (!before) notFound();
    if (before.enabled !== enabled) {
      await getWebDb().transaction(async (tx) => {
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
      });
    }
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?group=${before.groupId}&saved=emoji-toggled`);
  },
});
