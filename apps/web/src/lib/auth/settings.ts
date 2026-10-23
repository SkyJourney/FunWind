import { cache } from "react";
import { eq, sql } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";

/** 站点配置（site_settings；M12 安装向导接管写入） */

export type RegisterMode = "invite" | "open";

export const getRegisterMode = cache(async (): Promise<RegisterMode> => {
  const db = getWebDb();
  const rows = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, "register.mode"))
    .limit(1);
  const mode = (rows[0]?.value as { mode?: string } | undefined)?.mode;
  return mode === "open" ? "open" : "invite"; // 默认邀请制（保守）
});

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = getWebDb();
  await db
    .insert(siteSettings)
    .values({ key, value: value as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: value as object, updatedAt: sql`NOW()` } });
}
