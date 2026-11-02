"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { isKnownPackId } from "@/lib/theme/catalog";
import {
  THEME_PREVIEW_COOKIE,
  THEME_PREVIEW_TTL_SEC,
  signThemePreview,
  themePreviewSecret,
} from "@/lib/theme/preview";

/**
 * 全站主题预览（M11.1 Step 7）：站长在编辑器「全站预览」→ 签名 cookie 10 分钟内本人浏览器
 * 按该包渲染整站；「退出预览」清 cookie。不写库、不影响其他访客。
 * 两个动作都走 defineAction 骨架（use-server-exports-guard 要求）。
 */

const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

async function setPreviewCookie(packId: string): Promise<never> {
  const store = await cookies();
  store.set(
    THEME_PREVIEW_COOKIE,
    signThemePreview(packId, Date.now() / 1000, themePreviewSecret()),
    {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: THEME_PREVIEW_TTL_SEC,
      secure: process.env.NODE_ENV === "production",
    },
  );
  // 预览改变 layout 直出：整站失效，下一请求即新主题
  revalidatePath("/", "layout");
  redirect(`/admin/themes/${encodeURIComponent(packId)}?preview=1`);
}

/** 开启全站预览：packId 须过目录校验（含内置 default 等保留字包） */
export const startThemePreviewAction = defineAction({
  name: "admin.theme.preview.start",
  auth: { admin: "site.admin" },
  input: z.object({ packId: z.string().max(32) }),
  async run(_ctx, input) {
    if (!PACK_ID_RE.test(input.packId) || !(await isKnownPackId(input.packId))) {
      redirect("/admin/themes?err=not-found");
    }
    await setPreviewCookie(input.packId);
  },
});

/** 退出全站预览：清 cookie 并回到主题管理列表 */
export const stopThemePreviewAction = defineAction({
  name: "admin.theme.preview.stop",
  auth: { admin: "site.admin" },
  async run() {
    const store = await cookies();
    store.delete(THEME_PREVIEW_COOKIE);
    revalidatePath("/", "layout");
    redirect("/admin/themes");
  },
});
