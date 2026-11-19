"use server";

import { defineAction } from "@/lib/actions/define-action";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect, notFound } from "next/navigation";
import { emojiGroups, emojis, getWebDb, insertIdOf } from "@funwind/db";
import { writeAudit, type DbTx } from "@/lib/audit";
import { getStorageDir } from "@/lib/storage";
import { processEmojiUpload } from "@/lib/emoji/admin";
import { upsertFileRecordInTx } from "@/lib/uploads/file-record";
import { ConfigActor } from "@/lib/audit";
import {
  createEmojiGroup,
  deleteEmojiGroup,
  renameEmojiGroup,
  reorderEmojiGroup,
  toggleEmojiEnabled,
  toggleEmojiGroupEnabled,
  updateEmoji,
} from "@/lib/emoji/service";

/**
 * 社区表情管理动作（M10.9，设计稿 §2.5）：门禁 emoji.manage（admin 默认持有）。
 * 元数据七动作的写入语义在 lib/emoji/service.ts（M20.3 Step 4 抽出，与 REST 双入口共享内核）；
 * 本文件保留上传两动作（组标题图、表情批量上传——耦合图片处理管线，不进 REST）与
 * redirect/notFound/revalidatePath 的表单语义。
 * 所有变更与 audit_log 同事务（不存在改了表情却没留痕的窗口）。
 * 上传的上限与格式校验在 lib/emoji/admin.ts（≤200×200、≤200KB、png/gif/webp）；
 * 表情不写 file_uploads、不占用户配额（files 表只做内容登记，供 gc 巡检识别）。
 */

const back = z.string().max(200).default("/admin/emojis");
const actorOf = (ctx: { userId: number | null; ip: string | null }): ConfigActor => ({
  userId: ctx.userId,
  ip: ctx.ip,
  via: "admin",
});

/** 结果码 → 表单回跳（missing/not_found 统一 notFound；其余按码拼 query） */
function redirectFor(
  back: string,
  result: { ok: true; changed?: boolean } | { ok: false; code: string },
  okMark: string,
  errMark?: string,
): never {
  if (!result.ok && result.code === "not_found") notFound();
  if (!result.ok) redirect(`${back}?err=${encodeURIComponent(errMark ?? result.code)}`);
  redirect(`${back}?ok=${okMark}`);
}

async function lockEmojiGroup(tx: DbTx, id: number) {
  const [group] = await tx
    .select()
    .from(emojiGroups)
    .where(eq(emojiGroups.id, id))
    .limit(1)
    .for("update");
  return group;
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
    const result = await createEmojiGroup(actorOf(ctx), input.name);
    redirectFor(input.back, result, "group-created", "name-exists");
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
      const { fileId } = await upsertFileRecordInTx(tx, r);
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
        after: { iconKey: r.storageKey, fileId, via: "admin" },
        ip: ctx.ip,
      });
    });
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?group=${group.id}&ok=group-icon`);
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
    const result = await renameEmojiGroup(actorOf(ctx), input.id, input.name);
    redirectFor(input.back, result, "group-renamed", "name-exists");
  },
});

export const toggleGroupAction = defineAction({
  name: "admin.emoji.group.toggle",
  auth: { admin: "emoji.manage" },
  input: z.object({ id: z.coerce.number().int().positive(), enabled: z.enum(["0", "1"]), back }),
  async run(ctx, input) {
    const result = await toggleEmojiGroupEnabled(actorOf(ctx), input.id, input.enabled === "1");
    redirectFor(input.back, result, "group-toggled");
  },
});

export const deleteGroupAction = defineAction({
  name: "admin.emoji.group.delete",
  auth: { admin: "emoji.manage" },
  input: z.object({ id: z.coerce.number().int().positive(), back }),
  async run(ctx, input) {
    const result = await deleteEmojiGroup(actorOf(ctx), input.id);
    redirectFor(input.back, result, "group-deleted", "group-not-empty");
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
        const { fileId } = await upsertFileRecordInTx(tx, p);
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
            fileId,
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
    redirect(`${input.back}?group=${group.id}&ok=upload&uploaded=${processed.length}${failedQ}`);
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
    const result = await updateEmoji(actorOf(ctx), input.id, {
      name: input.name,
      keywords: input.keywords,
      sort: input.sort,
    });
    if (!result.ok && result.code === "not_found") notFound();
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?ok=emoji-renamed`);
  },
});

export const toggleEmojiAction = defineAction({
  name: "admin.emoji.toggle",
  auth: { admin: "emoji.manage" },
  input: z.object({ id: z.coerce.number().int().positive(), enabled: z.enum(["0", "1"]), back }),
  async run(ctx, input) {
    const result = await toggleEmojiEnabled(actorOf(ctx), input.id, input.enabled === "1");
    if (!result.ok && result.code === "not_found") notFound();
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?ok=emoji-toggled`);
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
    const result = await reorderEmojiGroup(actorOf(ctx), input.id, input.sort);
    if (!result.ok && result.code === "not_found") notFound();
    revalidatePath("/admin/emojis");
    redirect(`${input.back}?ok=group-moved`);
  },
});
