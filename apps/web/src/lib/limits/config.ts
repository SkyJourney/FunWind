import { DEFAULT_LIMITS } from "@funwind/db";
import { z } from "zod";
import type { ForumTree } from "@/lib/forums/forum-tree";
import type { Subject } from "@/lib/authz/types";

/**
 * 写入限制（M6.1，设计见 docs/milestones/M6.1-write-path.md §6）。纯逻辑，无 IO；读库在 load.ts。
 *
 * 配置存在 site_settings 的 `limits` 键，zod 校验。**校验失败整体回落默认值**（并告警）——
 * 一份写坏的配置不应该让发帖整体不可用，更不应该意外变成"不限制"：所以每个角色项必须写全三个字段
 * （缺一个就整体无效），因为 0 的含义是"不限"，缺省补 0 会悄悄放开限制。
 */

const nonNegInt = (max: number) => z.number().int().min(0).max(max);

const roleLimitsSchema = z
  .object({
    /** 两次发帖的最短间隔（秒）；0 = 不限 */
    postIntervalSec: nonNegInt(3600),
    /** 每个自然日最多发主题数；0 = 不限 */
    threadsPerDay: nonNegInt(100_000),
    /** 每个自然日最多上传文件数；0 = 不限 */
    uploadsPerDay: nonNegInt(100_000),
  })
  .strict();

export const limitsConfigSchema = z
  .object({
    /** 标题最大字符数（threads.title 是 varchar(255)，上限不得超过它） */
    titleMax: z.number().int().min(1).max(255),
    /** 正文最大字符数（公开部分 + 全部门控隐藏正文合计） */
    bodyMax: z.number().int().min(1).max(1_000_000),
    /** 角色稳定键（与 roles.key 一致）→ 该角色的限制；未列出的角色不参与取值 */
    roles: z.record(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), roleLimitsSchema),
  })
  .strict();

export type LimitsConfig = z.infer<typeof limitsConfigSchema>;
export type RoleLimits = z.infer<typeof roleLimitsSchema>;

/** 默认配置（来自 packages/db 的 DEFAULT_LIMITS；由单测保证它能通过上面的校验） */
export const DEFAULT_LIMITS_CONFIG: LimitsConfig = limitsConfigSchema.parse(DEFAULT_LIMITS);

/** 解析库里读到的原始值；缺失 → 默认（不告警）；无效 → 默认并带上错误说明供调用方告警 */
export function parseLimitsConfig(raw: unknown): { config: LimitsConfig; error?: string } {
  if (raw === undefined || raw === null) return { config: DEFAULT_LIMITS_CONFIG };
  const r = limitsConfigSchema.safeParse(raw);
  if (r.success) return { config: r.data };
  const first = r.error.issues[0];
  const where = first ? first.path.join(".") || "(根)" : "?";
  return { config: DEFAULT_LIMITS_CONFIG, error: `${where}: ${first?.message ?? "无效"}` };
}

/** 对某个主体、某个版块最终生效的限制；三项每日 / 间隔限制里 0 = 不限 */
export interface ResolvedLimits extends RoleLimits {
  titleMax: number;
  bodyMax: number;
}

/**
 * 在目标版块作用域内对主体生效的角色键：全局绑定恒适用；版块作用域的绑定只在该版块（含子树）内适用。
 * 与评估器的作用域口径一致（scopeId 在目标版块的祖先链上）。forumId 缺省 = 站点级，只取全局绑定。
 */
export function applicableRoleKeys(subject: Subject, tree: ForumTree, forumId?: number): string[] {
  const chain = forumId !== undefined ? tree.chain(forumId) : [];
  const keys = subject.roles
    .filter((r) => r.scopeId === 0 || chain.includes(r.scopeId))
    .map((r) => r.key);
  return [...new Set(keys)];
}

/**
 * 合并多个角色的限制，每项取**最宽松**的值：
 *  · postIntervalSec：间隔越短越宽松 → 取最小值（0 = 没有间隔限制，自然最小）；
 *  · threadsPerDay / uploadsPerDay：额度越大越宽松，**0 = 不限，胜过任何正数**——不能直接 Math.max（正数会把 0 误吞）。
 * 没有任何角色匹配（游客；登录用户恒带 member，所以实际上只有游客）时回落到 member 项，
 * 再没有就用默认的 member 项——宁可保守，绝不能因为"没匹配到"变成不限。
 */
export function resolveLimits(config: LimitsConfig, roleKeys: readonly string[]): ResolvedLimits {
  let matched = roleKeys
    .map((k) => config.roles[k])
    .filter((x): x is RoleLimits => x !== undefined);
  if (matched.length === 0) {
    const fallback = config.roles["member"] ?? DEFAULT_LIMITS_CONFIG.roles["member"];
    matched = fallback ? [fallback] : [];
  }
  const quota = (pick: (r: RoleLimits) => number): number => {
    const vals = matched.map(pick);
    return vals.includes(0) ? 0 : Math.max(...vals);
  };
  return {
    titleMax: config.titleMax,
    bodyMax: config.bodyMax,
    postIntervalSec: Math.min(...matched.map((r) => r.postIntervalSec)),
    threadsPerDay: quota((r) => r.threadsPerDay),
    uploadsPerDay: quota((r) => r.uploadsPerDay),
  };
}
