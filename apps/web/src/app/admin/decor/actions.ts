"use server";

import { defineAction } from "@/lib/actions/define-action";
import { redirect } from "next/navigation";
import {
  activateInBrandPool,
  brandFileInput,
  brandUploadInput,
  removeBrandPoolItem,
  uploadToBrandPool,
} from "@/lib/brand/pool-actions";
import { decorFs } from "@/lib/brand/decor-pool-fs";
import { decorPool } from "@/lib/brand/decor-pool";
import { getWebDb, themePackages } from "@funwind/db";
import { getThemePackDecorRefs } from "@/lib/theme/packs";
import { parseThemePackDefinition } from "@/lib/theme/surface-schema";

/**
 * 主题装饰素材池管理动作（M11.1 Step 4）：门禁 site.admin；
 * 上传为 PNG（≤4MB、≤3840×2160，服务端验魔数与像素），池元数据进 site_settings。
 * 素材供主题包引用（图片底纹/装饰图），不经附件授权管线。
 * schema 与 run 体在 lib/brand/pool-actions（泛化）；此处保留字面 defineAction 供两个静态守护审计。
 */

export const uploadDecorAction = defineAction({
  name: "admin.decor.upload",
  auth: { admin: "site.admin" },
  input: brandUploadInput("/admin/decor"),
  async run(ctx, input) {
    return uploadToBrandPool(decorFs, ctx, input, "/admin/decor");
  },
});

export const setActiveDecorAction = defineAction({
  name: "admin.decor.activate",
  auth: { admin: "site.admin" },
  input: brandFileInput("/admin/decor"),
  async run(ctx, input) {
    return activateInBrandPool(decorPool, ctx, input, "/admin/decor");
  },
});

export const removeDecorAction = defineAction({
  name: "admin.decor.remove",
  auth: { admin: "site.admin" },
  input: brandFileInput("/admin/decor"),
  async run(ctx, input) {
    const rows = await getWebDb().select().from(themePackages);
    const usedBy = rows.find((row) => {
      const parsed = parseThemePackDefinition(row.definition);
      return parsed.ok && getThemePackDecorRefs(parsed.value).includes(input.file);
    });
    if (usedBy) redirect(`/admin/decor?err=in-use&file=${encodeURIComponent(input.file)}`);
    return removeBrandPoolItem(decorPool, ctx, input, "/admin/decor");
  },
});
