import "server-only";

import { isDeepStrictEqual } from "node:util";
import { cache } from "react";
import { eq, inArray, sql } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";
import { CLI_ACTOR, writeAudit, type ConfigActor, type DbTx } from "@/lib/audit";
import { getActiveRegisterWindow } from "@/lib/campaigns/service";
import type { ModerationApiTrace } from "@/lib/moderation/contents";
import {
  applyRegisterWindow,
  DEFAULT_REGISTER_POLICY,
  resolveRegisterPolicy,
  type RegisterPolicy,
} from "./register-policy";

/** 站点配置（site_settings；M12 安装向导接管写入） */

export type RegisterMode = "invite" | "open";

/**
 * 注册策略——**站点设置原值**（M11.3；M11.4 Step 2 F1 拆分）：读 `register.policy`
 * （M20 清账：旧 register.mode 读兼容层已移除，存量库由 bootstrap 搬迁收敛）。
 * 读不到或写坏都回落默认（邀请制）并告警，不让一份坏配置把注册意外放开或整体不可用。
 * 取代原 `email.verification`（open_only/always）：验证要求现在只是策略里的一个布尔，且只作用于开放注册。
 *
 * 只给后台设置页用：勾选框展示与保存写回的都必须是原值——若给设置页读「生效值」，
 * 开放注册窗口生效期间保存设置会把排期带来的「开」永久写进库（M11.4 §2.2 F1）。
 */
const getSiteRegisterPolicy = cache(async (): Promise<RegisterPolicy> => {
  let byKey: Map<string, unknown>;
  try {
    const rows = await getWebDb()
      .select({ key: siteSettings.key, value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, "register.policy"));
    byKey = new Map(rows.map((r) => [r.key, r.value]));
  } catch (e) {
    // 零表韧性（M12）：全新部署在安装第 1 步之前连 site_settings 表都不存在——
    // 按默认（邀请制）处理并告警。fail-closed 保守方向：读不到 = 不放开注册。
    console.warn("[auth] 读取注册策略失败（库表可能尚未创建），已按邀请制处理:", e);
    return { ...DEFAULT_REGISTER_POLICY };
  }
  const { policy, error } = resolveRegisterPolicy(byKey.get("register.policy"));
  if (error) console.warn(`[auth] site_settings.register.policy 无效，已回落到邀请制：${error}`);
  return policy;
});
export { getSiteRegisterPolicy };

/**
 * 注册策略——**生效值**（M11.3 + M11.4 Step 2）：站点原值之上叠加开放注册窗口（applyRegisterPolicyWindow）。
 * 注册页 / 注册 Action / 登录页 / 登录门判定都用它；顶栏「注册」入口在 site-chrome 里用同一条叠加规则
 * （30 秒进程缓存，窗口开始 / 结束时最多延迟 30 秒）。请求级缓存，窗口边界即时生效，无叠加延迟。
 */
export const getRegisterPolicy = cache(async (): Promise<RegisterPolicy> => {
  const policy = await getSiteRegisterPolicy();
  const window = await getActiveRegisterWindow();
  return applyRegisterWindow(policy, window !== null);
});

/**
 * 旧的单选视图，由策略派生：仅「开放」开着且「邀请」关着才算 open，其余一律 invite。
 * 目前只剩 `Subject.registerMode` 一个赋值方在用（全仓无消费者，见 M11.3 文档 §2）。
 */
export const getRegisterMode = cache(async (): Promise<RegisterMode> => {
  const policy = await getRegisterPolicy();
  return policy.open && !policy.invite ? "open" : "invite";
});

/** 按落库的 JSON 语义比较原值：对象键序无关，数组顺序与额外字段保留。 */
function settingValuesEqual(before: unknown, after: unknown): boolean {
  // 与 JSON 列使用相同的序列化语义，不经 REST 读侧或审计投影。
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  return (
    beforeJson === afterJson ||
    (beforeJson !== undefined &&
      afterJson !== undefined &&
      isDeepStrictEqual(JSON.parse(beforeJson), JSON.parse(afterJson)))
  );
}

/**
 * 站点设置写入：维持既有落库与更新时间口径，只在 JSON 值变化时同事务写前后值审计。
 * trace 仅 REST 写变体传入（M20.3 Step 5）：附加 requestId/tokenSuffix 到审计 after——
 * 后台调用不传 trace，审计形态零变化。
 */
export async function setSetting(
  key: string,
  value: unknown,
  actor: ConfigActor = CLI_ACTOR,
  trace?: ModerationApiTrace,
): Promise<void> {
  await getWebDb().transaction(async (tx) => {
    await applySettingInTx(tx, key, value, actor, { trace });
  });
}

/** 审计选项：REST 传入白名单投影；不传投影的后台等调用保持原值审计。 */
interface SettingAuditOptions {
  trace?: ModerationApiTrace;
  projectAuditValue?: (raw: unknown) => unknown;
}

/** 写入内核（后台与 REST 三段式变体共享，事务内调用）：行锁 upsert + 值变化才审计。 */
export async function applySettingInTx(
  tx: DbTx,
  key: string,
  value: unknown,
  actor: ConfigActor,
  { trace, projectAuditValue = (raw) => raw }: SettingAuditOptions = {},
): Promise<void> {
  const [prev] = await tx
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, key))
    .for("update");
  await tx
    .insert(siteSettings)
    .values({ key, value: value as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: value as object, updatedAt: sql`NOW()` } });
  if (!prev || !settingValuesEqual(prev.value, value)) {
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "setting.update",
      targetType: "setting",
      targetId: key,
      before: prev ? { value: projectAuditValue(prev.value) } : null,
      after: {
        value: projectAuditValue(value),
        via: actor.via,
        ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
      },
      ip: actor.ip,
    });
  }
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
      ({ key, value }) => !settingValuesEqual(prevByKey.get(key), value),
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
