"use server";

import { defineAction } from "@/lib/actions/define-action";
import {
  activateInBrandPool,
  brandFileInput,
  brandUploadInput,
  removeBrandPoolItem,
  uploadToBrandPool,
} from "@/lib/brand/pool-actions";
import { logoFs } from "@/lib/brand/logo-pool-fs";
import { logoPool } from "@/lib/brand/logo-pool";

/**
 * LOGO 池管理动作（M10.5，docs/LOGO-POOL.md）：门禁 site.admin；
 * 上传为 PNG（≤512KB，服务端验魔数），池元数据进 site_settings，切换即失效 chrome 缓存。
 * schema 与 run 体在 lib/brand/pool-actions（M11 泛化）；此处保留字面 defineAction 供两个静态守护审计。
 */

export const uploadLogoAction = defineAction({
  name: "admin.logo.upload",
  auth: { admin: "site.admin" },
  input: brandUploadInput("/admin/logo"),
  async run(ctx, input) {
    return uploadToBrandPool(logoFs, ctx, input, "/admin/logo");
  },
});

export const setActiveLogoAction = defineAction({
  name: "admin.logo.activate",
  auth: { admin: "site.admin" },
  input: brandFileInput("/admin/logo"),
  async run(ctx, input) {
    return activateInBrandPool(logoPool, ctx, input, "/admin/logo");
  },
});

export const removeLogoAction = defineAction({
  name: "admin.logo.remove",
  auth: { admin: "site.admin" },
  input: brandFileInput("/admin/logo"),
  async run(ctx, input) {
    return removeBrandPoolItem(logoPool, ctx, input, "/admin/logo");
  },
});
