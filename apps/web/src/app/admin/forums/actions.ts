"use server";

import { defineAction } from "@/lib/actions/define-action";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { addPrefix, createForum, deleteForum, removePrefix, updateForum } from "@/lib/forums/admin";
import { processForumIcon } from "@/lib/forums/icon";
import { getStorageDir } from "@/lib/storage";
import { MIME_OF } from "@/lib/uploads/types";

/**
 * 版块管理动作（M10.6a）：门禁 site.admin（LOGO 同判例，站点级结构语义）。
 * 服务端失败以 ?err=code 回到来源页（文案见列表页 ERR_TEXT）；成功 revalidate 后跳回。
 */

const ERR_HOP = (back: string, code: string) =>
  `${back}${back.includes("?") ? "&" : "?"}err=${encodeURIComponent(code)}`;

const readPolicy = z.enum(["inherit", "public", "members", "restricted"]);
const writePolicy = z.enum(["inherit", "members", "restricted"]);
const reviewPolicy = z.enum(["inherit", "none", "threads", "all"]);

const baseFields = {
  parentId: z.coerce.number().int().min(0).max(4_294_967_295),
  kind: z.enum(["section", "forum"]),
  name: z.string().trim().min(1, "名称不能为空").max(100),
  description: z.string().max(2000).default(""),
  sortOrder: z.coerce.number().int().min(0).max(1_000_000).default(0),
  isListed: z.string().default(""),
};

const actorOf = (ctx: { userId: number | null; ip: string | null }) => ({
  userId: ctx.userId,
  ip: ctx.ip,
});

export const createForumAction = defineAction({
  name: "admin.forum.create",
  auth: { admin: "site.admin" },
  input: z.object(baseFields),
  async run(ctx, input) {
    const r = await createForum(actorOf(ctx), {
      parentId: input.parentId,
      kind: input.kind,
      name: input.name,
      description: input.description.trim() === "" ? null : input.description.trim(),
      sortOrder: input.sortOrder,
      isListed: input.isListed === "on",
    });
    if (!r.ok) redirect(ERR_HOP("/admin/forums", r.code));
    revalidatePath("/admin/forums");
    redirect(`/admin/forums/${r.id}`);
  },
});

export const updateForumAction = defineAction({
  name: "admin.forum.update",
  auth: { admin: "site.admin" },
  input: z.object({
    ...baseFields,
    fid: z.coerce.number().int().min(1),
    readPolicy,
    writePolicy,
    reviewPolicy,
    isArchived: z.string().default(""),
    back: z.string().max(200).default(""),
  }),
  async run(ctx, input) {
    const back = input.back || `/admin/forums/${input.fid}`;
    const r = await updateForum(actorOf(ctx), input.fid, {
      parentId: input.parentId,
      name: input.name,
      description: input.description.trim() === "" ? null : input.description.trim(),
      sortOrder: input.sortOrder,
      isListed: input.isListed === "on",
      readPolicy: input.readPolicy,
      writePolicy: input.writePolicy,
      reviewPolicy: input.reviewPolicy,
      isArchived: input.isArchived === "on",
    });
    if (!r.ok) redirect(ERR_HOP(back, r.code));
    revalidatePath("/admin/forums");
    revalidatePath(`/admin/forums/${input.fid}`);
    redirect(back);
  },
});

export const deleteForumAction = defineAction({
  name: "admin.forum.delete",
  auth: { admin: "site.admin" },
  input: z.object({ fid: z.coerce.number().int().min(1) }),
  async run(ctx, input) {
    const r = await deleteForum(actorOf(ctx), input.fid);
    if (!r.ok) redirect(ERR_HOP(`/admin/forums/${input.fid}`, r.code));
    revalidatePath("/admin/forums");
    redirect("/admin/forums");
  },
});

export const addPrefixAction = defineAction({
  name: "admin.forum.prefix.add",
  auth: { admin: "site.admin" },
  input: z.object({
    fid: z.coerce.number().int().min(1),
    name: z.string().trim().min(1, "前缀名不能为空").max(64),
    sortOrder: z.coerce.number().int().min(0).max(32_767).default(0),
  }),
  async run(ctx, input) {
    const r = await addPrefix(actorOf(ctx), input.fid, {
      name: input.name,
      sortOrder: input.sortOrder,
    });
    if (!r.ok) redirect(ERR_HOP(`/admin/forums/${input.fid}`, r.code));
    revalidatePath(`/admin/forums/${input.fid}`);
    redirect(`/admin/forums/${input.fid}`);
  },
});

export const removePrefixAction = defineAction({
  name: "admin.forum.prefix.remove",
  auth: { admin: "site.admin" },
  input: z.object({
    fid: z.coerce.number().int().min(1),
    prefixId: z.coerce.number().int().min(1),
  }),
  async run(ctx, input) {
    const r = await removePrefix(actorOf(ctx), input.fid, input.prefixId);
    if (!r.ok) redirect(ERR_HOP(`/admin/forums/${input.fid}`, r.code));
    revalidatePath(`/admin/forums/${input.fid}`);
    redirect(`/admin/forums/${input.fid}`);
  },
});

/**
 * 板块图上传/更换（M9.5 §3.4）：processForumIcon 管线（≤512×512 ≤300KB）→ files 登记（同事务）
 * → forums.icon_key 覆盖写（旧文件不强删——内容寻址存储约定）→ 审计 admin.forum.icon。
 */
export const uploadForumIconAction = defineAction({
  name: "admin.forum.icon",
  auth: { admin: "site.admin" },
  input: z.object({
    fid: z.coerce.number().int().min(1),
    icon: z.instanceof(File),
    back: z.string().max(200).default(""),
  }),
  async run(ctx, input) {
    const bytes = Buffer.from(await input.icon.arrayBuffer());
    const storageDir = getStorageDir();
    const r = await processForumIcon(bytes, storageDir);
    if (!r.ok) {
      redirect(
        `${input.back || `/admin/forums/${input.fid}`}?iconErr=${encodeURIComponent(r.message)}`,
      );
    }
    const { files, forums, getWebDb } = await import("@funwind/db");
    const { eq, sql } = await import("drizzle-orm");
    const { writeAudit } = await import("@/lib/audit");
    await getWebDb().transaction(async (tx) => {
      await tx
        .insert(files)
        .ignore()
        .values({
          sha256: r.sha256,
          storageKey: r.storageKey,
          sizeBytes: r.sizeBytes,
          mime: MIME_OF[r.ext as keyof typeof MIME_OF],
          width: r.width,
          height: r.height,
          createdAt: sql`NOW()`,
        });
      const [fileRow] = await tx
        .select({ id: files.id })
        .from(files)
        .where(eq(files.sha256, r.sha256))
        .limit(1);
      await tx.update(forums).set({ iconKey: r.storageKey }).where(eq(forums.id, input.fid));
      await writeAudit(tx, {
        actorId: ctx.userId,
        action: "admin.forum.icon",
        targetType: "forum",
        targetId: input.fid,
        after: { storageKey: r.storageKey, fileId: fileRow?.id, via: "admin" },
        ip: ctx.ip,
      });
    });
    revalidatePath("/admin/forums");
    revalidatePath(`/admin/forums/${input.fid}`);
    revalidatePath("/boards");
    redirect(`${input.back || `/admin/forums/${input.fid}`}?iconSaved=1`);
  },
});

/** 板块图移除（icon_key 置 NULL；ConfirmSubmit 前端确认，审计同上） */
export const removeForumIconAction = defineAction({
  name: "admin.forum.icon.remove",
  auth: { admin: "site.admin" },
  input: z.object({
    fid: z.coerce.number().int().min(1),
    back: z.string().max(200).default(""),
  }),
  async run(ctx, input) {
    const { getWebDb, forums } = await import("@funwind/db");
    const { eq } = await import("drizzle-orm");
    const { writeAudit } = await import("@/lib/audit");
    await getWebDb().transaction(async (tx) => {
      await tx.update(forums).set({ iconKey: null }).where(eq(forums.id, input.fid));
      await writeAudit(tx, {
        actorId: ctx.userId,
        action: "admin.forum.icon.remove",
        targetType: "forum",
        targetId: input.fid,
        after: { via: "admin" },
        ip: ctx.ip,
      });
    });
    revalidatePath("/admin/forums");
    revalidatePath(`/admin/forums/${input.fid}`);
    revalidatePath("/boards");
    redirect(`${input.back || `/admin/forums/${input.fid}`}?iconRemoved=1`);
  },
});
