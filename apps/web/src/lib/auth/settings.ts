import { cache } from "react";
import { eq, inArray, sql } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";
import { CLI_ACTOR, writeAudit, type ConfigActor } from "@/lib/audit";

/** 站点配置（site_settings；M12 安装向导接管写入） */

export type RegisterMode = "invite" | "open";

/** 新注册账号的邮箱验证策略；计算结果写入用户行，后续注册模式切换不改变既有账号的验证门 */
export type EmailVerificationMode = "open_only" | "always";

export const getEmailVerificationMode = cache(async (): Promise<EmailVerificationMode> => {
  const db = getWebDb();
  const rows = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, "email.verification"))
    .limit(1);
  const mode = (rows[0]?.value as { mode?: string } | undefined)?.mode;
  return mode === "always" ? "always" : "open_only";
});

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

/** 站点设置写入：管理动作，值真正变化时同事务写 audit_log（前后值）；写入相同值是幂等空操作 */
export async function setSetting(
  key: string,
  value: unknown,
  actor: ConfigActor = CLI_ACTOR,
): Promise<void> {
  await getWebDb().transaction(async (tx) => {
    const [prev] = await tx
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, key))
      .for("update");
    await tx
      .insert(siteSettings)
      .values({ key, value: value as object, updatedAt: sql`NOW()` })
      .onDuplicateKeyUpdate({ set: { value: value as object, updatedAt: sql`NOW()` } });
    if (!prev || JSON.stringify(prev.value) !== JSON.stringify(value)) {
      await writeAudit(tx, {
        actorId: actor.userId,
        action: "setting.update",
        targetType: "setting",
        targetId: key,
        before: prev ? { value: prev.value } : null,
        after: { value, via: actor.via },
        ip: actor.ip,
      });
    }
  });
}

/**
 * 多键站点设置写入：单事务提交一组相关联的键（如积分显示名与奖励数值），
 * 按 key 排序加锁避免与其它多键写入交叉死锁；有变化时只写一条合并审计
 * （before/after 按键记录），避免「半更新 + 两条互相矛盾的审计」。
 */
export async function setSettings(
  entries: ReadonlyArray<{ key: string; value: unknown }>,
  actor: ConfigActor = CLI_ACTOR,
): Promise<void> {
  const ordered = [...entries].sort((a, b) => (a.key < b.key ? -1 : 1));
  if (ordered.length === 0) return;
  await getWebDb().transaction(async (tx) => {
    const prev = await tx
      .select({ key: siteSettings.key, value: siteSettings.value })
      .from(siteSettings)
      .where(
        inArray(
          siteSettings.key,
          ordered.map((e) => e.key),
        ),
      )
      .orderBy(siteSettings.key)
      .for("update");
    const prevByKey = new Map(prev.map((row) => [row.key, row.value]));
    for (const { key, value } of ordered) {
      await tx
        .insert(siteSettings)
        .values({ key, value: value as object, updatedAt: sql`NOW()` })
        .onDuplicateKeyUpdate({ set: { value: value as object, updatedAt: sql`NOW()` } });
    }
    const changed = ordered.filter(
      ({ key, value }) => JSON.stringify(prevByKey.get(key)) !== JSON.stringify(value),
    );
    if (changed.length > 0) {
      await writeAudit(tx, {
        actorId: actor.userId,
        action: "setting.update",
        targetType: "setting",
        targetId: changed.map((c) => c.key).join(","),
        before: Object.fromEntries(changed.map((c) => [c.key, prevByKey.get(c.key) ?? null])),
        after: Object.fromEntries(changed.map((c) => [c.key, { value: c.value, via: actor.via }])),
        ip: actor.ip,
      });
    }
  });
}

/** 积分显示名（site_settings.points.name；默认“积分”，青翼导入后为“青翼币”） */
export const getPointsName = cache(async (): Promise<string> => {
  const rows = await getWebDb()
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, "points.name"))
    .limit(1);
  return (rows[0]?.value as { name?: string } | undefined)?.name ?? "积分";
});
