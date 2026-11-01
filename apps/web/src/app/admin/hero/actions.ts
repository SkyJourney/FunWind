"use server";

import { defineAction } from "@/lib/actions/define-action";
import {
  activateInBrandPool,
  brandFileInput,
  brandUploadInput,
  removeBrandPoolItem,
  uploadToBrandPool,
} from "@/lib/brand/pool-actions";
import { heroFs } from "@/lib/brand/hero-pool-fs";
import { heroPool } from "@/lib/brand/hero-pool";

/**
 * 首页 Hero 横幅池管理动作（M11 插槽 ⑤）：门禁 site.admin；
 * 上传为 PNG（≤2MB、≤1920×1080，服务端验魔数与像素），池元数据进 site_settings，切换即失效 chrome 缓存。
 * schema 与 run 体在 lib/brand/pool-actions（泛化）；此处保留字面 defineAction 供两个静态守护审计。
 */

export const uploadHeroAction = defineAction({
  name: "admin.hero.upload",
  auth: { admin: "site.admin" },
  input: brandUploadInput("/admin/hero"),
  async run(ctx, input) {
    return uploadToBrandPool(heroFs, ctx, input, "/admin/hero");
  },
});

export const setActiveHeroAction = defineAction({
  name: "admin.hero.activate",
  auth: { admin: "site.admin" },
  input: brandFileInput("/admin/hero"),
  async run(ctx, input) {
    return activateInBrandPool(heroPool, ctx, input, "/admin/hero");
  },
});

export const removeHeroAction = defineAction({
  name: "admin.hero.remove",
  auth: { admin: "site.admin" },
  input: brandFileInput("/admin/hero"),
  async run(ctx, input) {
    return removeBrandPoolItem(heroPool, ctx, input, "/admin/hero");
  },
});
