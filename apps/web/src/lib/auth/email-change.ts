import "server-only";

import { and, eq, ne } from "drizzle-orm";
import { emailTokens, getWebDb, users } from "@funwind/db";
import { writeAudit } from "@/lib/audit";
import { lockActiveUserInTx } from "@/lib/identity";
import { isDuplicateKey } from "./register";
import { hashEmailKey, issueEmailTokenInTx } from "./tokens";

class TargetVerificationRateLimited extends Error {}

export type EmailChangeResult =
  | {
      kind: "changed";
      beforeEmail: string | null;
      emailChanged: boolean;
      /** 旧邮箱是否被用户验证过：没验证过的地址从未被证明属于该用户，管理员代改时不给它发告警 */
      previouslyVerified: boolean;
      verifyToken: string;
    }
  | { kind: "taken" }
  | { kind: "missing" }
  | { kind: "unchanged" }
  | { kind: "rate_limited" };

/**
 * 审计归属。省略 = 用户自己改（记用户本人、动作 user.email.change）；
 * 管理员代改时传入，同时启用与限制 / 角色授予一致的目标账号检查（注销冷静期与已注销账号一律拒绝）。
 */
export type EmailChangeAudit = { actorId: number; action: string };

/** 改绑邮箱、清理旧令牌并签发新地址验证令牌；单次事务内串行化。 */
export async function changeEmailAddress(
  userId: number,
  email: string,
  emailKey: string,
  ip: string | null,
  allowTargetVerification: () => boolean = () => true,
  audit?: EmailChangeAudit,
): Promise<EmailChangeResult> {
  try {
    return await getWebDb().transaction(async (tx) => {
      if (audit) {
        const target = await lockActiveUserInTx(tx, userId);
        if (!target.ok) return { kind: "missing" };
      }
      const [current] = await tx
        .select({
          email: users.email,
          emailKey: users.emailKey,
          emailVerifiedAt: users.emailVerifiedAt,
          state: users.state,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (!current || current.state !== "active") return { kind: "missing" };

      const [taken] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.emailKey, emailKey), ne(users.id, userId)))
        .limit(1);
      if (taken) return { kind: "taken" };
      if (current.emailKey === emailKey && current.emailVerifiedAt !== null) {
        return { kind: "unchanged" };
      }

      await tx
        .update(users)
        .set({
          email,
          emailKey,
          emailVerifiedAt: null,
          emailVerificationRequired: true,
        })
        .where(eq(users.id, userId));
      await tx.delete(emailTokens).where(eq(emailTokens.userId, userId));
      const verifyToken = await issueEmailTokenInTx(tx, userId, "verify", emailKey);
      await writeAudit(tx, {
        actorId: audit?.actorId ?? userId,
        action: audit?.action ?? "user.email.change",
        targetType: "user",
        targetId: userId,
        before: { emailKey: current.emailKey ? hashEmailKey(current.emailKey) : null },
        after: { emailKey: hashEmailKey(emailKey), verificationRequired: true },
        ip,
      });
      if (!allowTargetVerification()) throw new TargetVerificationRateLimited();
      return {
        kind: "changed",
        beforeEmail: current.email,
        emailChanged: current.emailKey !== emailKey,
        previouslyVerified: current.emailVerifiedAt !== null,
        verifyToken,
      };
    });
  } catch (error) {
    if (error instanceof TargetVerificationRateLimited) return { kind: "rate_limited" };
    if (isDuplicateKey(error)) return { kind: "taken" };
    throw error;
  }
}
