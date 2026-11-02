"use server";

import { randomBytes } from "node:crypto";
import { defineAction } from "@/lib/actions/define-action";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { applyThemePackLogo } from "@/lib/theme/apply-pack-logo";
import { getDecorPoolRaw } from "@/lib/brand/decor-pool";
import { invalidateSiteChrome } from "@/lib/site-chrome";
import {
  copyThemePack,
  createThemePack,
  deleteThemePack,
  getThemePackDecorRefs,
  setSiteDefaultThemePack,
  setThemePackEnabled,
  updateThemePack,
} from "@/lib/theme/packs";
import { parseThemePackDefinition } from "@/lib/theme/surface-schema";

/**
 * 主题包管理动作（M11.1 Step 5，docs/milestones/M11.1-theme-engine.md）：
 * 门禁 site.admin；definition 以 JSON 文本提交，服务端 strict zod 校验后才入库；
 * 写操作与审计同事务（lib/theme/packs），revision 乐观锁防并发覆盖。
 * 设为全站默认时触发主题↔LOGO 联动（有自带 LOGO 才入池，docs/THEME-SYSTEM.md §5）。
 */

const actorOf = (ctx: { userId: number | null; ip: string | null }) => ({
  userId: ctx.userId,
  via: "admin" as const,
  ip: ctx.ip,
});

function packWriteFields(
  input: { id: string; name: string; description: string },
  definition: unknown,
  actor: ReturnType<typeof actorOf>,
) {
  return {
    id: input.id.trim().toLowerCase(),
    name: input.name.trim(),
    description: input.description.trim(),
    definition,
    actor,
  };
}

const packFields = {
  id: z.string().max(32),
  name: z.string().min(1).max(60),
  description: z.string().max(200).default(""),
  definition: z
    .string()
    .max(64 * 1024, "包配置过大（上限 64KB）")
    .default("{}"),
};

async function hasMissingDecorAssets(definition: unknown): Promise<boolean> {
  const parsed = parseThemePackDefinition(definition);
  if (!parsed.ok) return false;
  const refs = getThemePackDecorRefs(parsed.value);
  if (refs.length === 0) return false;
  const pool = await getDecorPoolRaw();
  const available = new Set(pool.items.map((item) => item.file));
  return refs.some((file) => !available.has(file));
}

function parseDefinitionOrRedirect(raw: string, returnPath: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    redirect(`${returnPath}?err=bad-json`);
  }
}

async function requireDecorAssets(definition: unknown, returnPath: string): Promise<void> {
  if (await hasMissingDecorAssets(definition)) redirect(`${returnPath}?err=missing-assets`);
}

/** 新建包：id + 名称 + 说明 + definition JSON */
export const createThemePackAction = defineAction({
  name: "admin.theme.pack.create",
  auth: { admin: "site.admin" },
  input: z.object(packFields),
  async run(ctx, input) {
    const parsed = parseDefinitionOrRedirect(input.definition, "/admin/themes");
    await requireDecorAssets(parsed, "/admin/themes");
    const result = await createThemePack(packWriteFields(input, parsed, actorOf(ctx)));
    if (!result.ok) redirect(`/admin/themes?err=${result.code}`);
    revalidatePath("/admin/themes");
    redirect(`/admin/themes?saved=created&id=${encodeURIComponent(input.id.trim().toLowerCase())}`);
  },
});

/** 保存包（编辑页提交）：带 revision，冲突报 err=conflict */
export const saveThemePackAction = defineAction({
  name: "admin.theme.pack.save",
  auth: { admin: "site.admin" },
  input: z.object({ ...packFields, revision: z.coerce.number().int().min(1) }),
  async run(ctx, input) {
    const returnPath = `/admin/themes/${encodeURIComponent(input.id)}`;
    const parsed = parseDefinitionOrRedirect(input.definition, returnPath);
    await requireDecorAssets(parsed, returnPath);
    const result = await updateThemePack({
      ...packWriteFields(input, parsed, actorOf(ctx)),
      expectedRevision: input.revision,
    });
    if (!result.ok) {
      redirect(`/admin/themes/${encodeURIComponent(input.id)}?err=${result.code}`);
    }
    revalidatePath("/admin/themes");
    revalidatePath(`/admin/themes/${encodeURIComponent(input.id)}`);
    redirect(`/admin/themes/${encodeURIComponent(input.id)}?saved=1`);
  },
});

/** 启停包 */
export const toggleThemePackAction = defineAction({
  name: "admin.theme.pack.toggle",
  auth: { admin: "site.admin" },
  input: z.object({
    id: z.string().max(32),
    enabled: z.enum(["0", "1"]),
  }),
  async run(ctx, input) {
    const result = await setThemePackEnabled(input.id, input.enabled === "1", actorOf(ctx));
    if (!result.ok) redirect(`/admin/themes?err=${result.code}`);
    invalidateSiteChrome();
    revalidatePath("/admin/themes");
    redirect("/admin/themes?saved=toggled");
  },
});

/** 复制包 */
export const copyThemePackAction = defineAction({
  name: "admin.theme.pack.copy",
  auth: { admin: "site.admin" },
  input: z.object({ sourceId: z.string().max(32) }),
  async run(ctx, input) {
    const newId = `${input.sourceId.slice(0, 19)}-copy-${randomBytes(3).toString("hex")}`;
    const result = await copyThemePack(input.sourceId, newId, actorOf(ctx));
    if (!result.ok) redirect(`/admin/themes?err=${result.code}`);
    revalidatePath("/admin/themes");
    redirect(`/admin/themes?saved=copied&id=${encodeURIComponent(newId)}`);
  },
});

/** 删除包 */
export const deleteThemePackAction = defineAction({
  name: "admin.theme.pack.delete",
  auth: { admin: "site.admin" },
  input: z.object({ id: z.string().max(32) }),
  async run(ctx, input) {
    const result = await deleteThemePack(input.id, actorOf(ctx));
    if (!result.ok) redirect(`/admin/themes?err=${result.code}`);
    invalidateSiteChrome();
    revalidatePath("/admin/themes");
    redirect("/admin/themes?saved=deleted");
  },
});

/** 设为全站默认主题（含 LOGO 联动） */
export const setDefaultThemePackAction = defineAction({
  name: "admin.theme.pack.default",
  auth: { admin: "site.admin" },
  input: z.object({ id: z.string().max(32) }),
  async run(ctx, input) {
    const actor = actorOf(ctx);
    const result = await setSiteDefaultThemePack(input.id, actor);
    if (!result.ok) redirect(`/admin/themes?err=${result.code}`);
    const logo = await applyThemePackLogo(input.id, { ...actor, via: "theme" });
    invalidateSiteChrome();
    revalidatePath("/admin/themes");
    revalidatePath("/", "layout");
    redirect(`/admin/themes?saved=${logo.applied ? "default_logo" : "default"}`);
  },
});
