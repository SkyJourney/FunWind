import { z } from "zod";

/**
 * 注册策略（M11.3，纯逻辑，无 IO；读库在 settings.ts）。
 *
 * 站点设置里「开放注册」「邀请注册」是两个独立开关，`verifyEmail` 只管开放注册：
 * 开放注册的账号必须先验证邮箱才能登录（站长 Q12：就是邮件验证，不再分层）。
 * 邀请注册的账号不要求验证。
 *
 * 配置存在 site_settings 的 `register.policy` 键，zod `.strict()` 校验。**键存在但内容无效时整体回落默认（邀请制）**，
 * 不回头去读旧 `register.mode`：站长保存过新策略之后被写坏，若悄悄退回一个早已过期的旧值，可能把注册意外放开。
 * 只有新键**不存在**时才按旧 `register.mode` 兼容映射，使升级前后站点行为零变化。
 */

export const registerPolicySchema = z
  .object({
    /** 开放注册：任何人凭邮箱注册，无需邀请码 */
    open: z.boolean(),
    /** 邀请注册：持有效邀请码可注册 */
    invite: z.boolean(),
    /** 开放注册的账号是否必须验证邮箱才能登录；不影响邀请注册 */
    verifyEmail: z.boolean(),
  })
  .strict();

export type RegisterPolicy = z.infer<typeof registerPolicySchema>;

/** 默认 = 现状（邀请制）：升级后不改变任何站点的行为 */
export const DEFAULT_REGISTER_POLICY: RegisterPolicy = {
  open: false,
  invite: true,
  verifyEmail: false,
};

/** 旧 `register.mode` → 新策略。旧开放模式本来就强制验证，所以 verifyEmail 为真以保持行为一致 */
export function policyFromLegacyMode(raw: unknown): RegisterPolicy {
  const mode = (raw as { mode?: unknown } | null | undefined)?.mode;
  return mode === "open"
    ? { open: true, invite: false, verifyEmail: true }
    : { ...DEFAULT_REGISTER_POLICY };
}

/**
 * 综合新旧两个键：
 *  · `register.policy` 存在且有效 → 用它；
 *  · 存在但无效 → 默认（邀请制），并带 error 供调用方告警；
 *  · 不存在 → 按旧 `register.mode` 映射（缺失时即默认邀请制）。
 */
export function resolveRegisterPolicy(
  policyRaw: unknown,
  legacyModeRaw: unknown,
): { policy: RegisterPolicy; error?: string } {
  if (policyRaw === undefined || policyRaw === null) {
    return { policy: policyFromLegacyMode(legacyModeRaw) };
  }
  const parsed = registerPolicySchema.safeParse(policyRaw);
  if (parsed.success) return { policy: parsed.data };
  const first = parsed.error.issues[0];
  const where = first ? first.path.join(".") || "(根)" : "?";
  return {
    policy: { ...DEFAULT_REGISTER_POLICY },
    error: `${where}: ${first?.message ?? "无效"}`,
  };
}

/** 访客此刻可用的注册路径，供注册页与注册 Action 共用同一份判定 */
export type RegisterAvailability =
  { kind: "closed" } | { kind: "invite-only" } | { kind: "open-only" } | { kind: "both" };

export function registerAvailability(policy: RegisterPolicy): RegisterAvailability {
  if (policy.open && policy.invite) return { kind: "both" };
  if (policy.open) return { kind: "open-only" };
  if (policy.invite) return { kind: "invite-only" };
  return { kind: "closed" };
}

/** 一次注册提交实际走哪条路径（Q7：双开时邀请码选填；填了无效邀请码报错，不降级成开放注册） */
export type RegisterPath =
  { kind: "closed" } | { kind: "invite" } | { kind: "open" } | { kind: "invite-required" };

/**
 * `hasInviteCode` 指「提交里邀请码非空」。
 *  · 双开：填了 → 邀请路径（码是否有效由核销事务判定，无效即报错，不降级）；没填 → 开放路径；
 *  · 仅邀请：不论填没填都走邀请路径；没填由 `invite-required` 区分，便于给出明确提示；
 *  · 仅开放：忽略邀请码，走开放路径；
 *  · 双关：closed。
 */
export function chooseRegisterPath(policy: RegisterPolicy, hasInviteCode: boolean): RegisterPath {
  const availability = registerAvailability(policy);
  switch (availability.kind) {
    case "closed":
      return { kind: "closed" };
    case "open-only":
      return { kind: "open" };
    case "invite-only":
      return hasInviteCode ? { kind: "invite" } : { kind: "invite-required" };
    case "both":
      return hasInviteCode ? { kind: "invite" } : { kind: "open" };
  }
}

/** 该路径注册的账号是否带「登录验证门」：只有开放路径且站点要求验证 */
export function pathRequiresVerification(policy: RegisterPolicy, path: RegisterPath): boolean {
  return path.kind === "open" && policy.verifyEmail;
}
