"use server";

import { defineAction } from "@/lib/actions/define-action";
import { z } from "zod";
import { addLogo } from "@/lib/brand/logo-pool-fs";
import { removeLogo, setActiveLogo } from "@/lib/brand/logo-pool";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

/**
 * LOGO 池管理动作（M10.5，docs/LOGO-POOL.md）：门禁 site.admin；
 * 上传为 PNG（≤512KB，服务端验魔数），池元数据进 site_settings，切换即失效 chrome 缓存。
 */

const backInput = z.object({ back: z.string().max(200).default("/admin/logo") });

export const uploadLogoAction = defineAction({
  name: "admin.logo.upload",
  auth: { admin: "site.admin" },
  input: z.object({
    name: z.string().max(40).default(""),
    file: z.instanceof(File),
    back: backInput.shape.back,
  }),
  async run(ctx, input) {
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    const r = await addLogo(input.name, bytes);
    if (!r.ok) redirect(`/admin/logo?err=${r.code}`);
    revalidatePath("/admin/logo");
    // 带 added 回跳：新入池项高亮（M9.5）
    redirect(`/admin/logo?added=${encodeURIComponent(r.pool.active ?? "")}`);
  },
});

export const setActiveLogoAction = defineAction({
  name: "admin.logo.activate",
  auth: { admin: "site.admin" },
  input: z.object({ file: z.string().max(64), back: backInput.shape.back }),
  async run(ctx, input) {
    await setActiveLogo(input.file);
    revalidatePath("/admin/logo");
    redirect(input.back);
  },
});

export const removeLogoAction = defineAction({
  name: "admin.logo.remove",
  auth: { admin: "site.admin" },
  input: z.object({ file: z.string().max(64), back: backInput.shape.back }),
  async run(ctx, input) {
    await removeLogo(input.file);
    revalidatePath("/admin/logo");
    redirect(input.back);
  },
});
