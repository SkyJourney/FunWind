import { and, eq, sql } from "drizzle-orm";
import { getWebDb, inviteCodes, normalizeKey, userProfiles, userStats, users } from "@funwind/db";

/**
 * 注册的数据库部分（从 Server Action 抽出以便做真实 DB 集成测试）。
 * 建用户（自增 id）、建资料行、核销邀请码在**同一事务**：任何一步失败整体回滚，
 * 不会出现“邀请码已被烧掉但用户没建成”，也没有 MAX(id)+1 的并发竞态。
 */

/** 业务校验失败（消息可直接展示给注册者）；抛出时事务整体回滚 */
export class RegisterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegisterError";
  }
}

/** 邀请码无效 / 已被使用 / 已过期：与「用户名或邮箱被占用」区分开，邀请码猜测限速只统计这一类（见 invite-limit.ts） */
export class InviteCodeError extends RegisterError {
  constructor() {
    super("邀请码无效或已被使用");
    this.name = "InviteCodeError";
  }
}

/** 唯一键冲突（drizzle 会把 mysql2 错误包在 cause 里） */
export function isDuplicateKey(e: unknown): boolean {
  const err = e as { code?: string; errno?: number; cause?: { code?: string; errno?: number } };
  return [err, err?.cause].some((x) => x?.code === "ER_DUP_ENTRY" || x?.errno === 1062);
}

export interface RegisterInput {
  username: string;
  email: string;
  passwordHash: string;
  /** 签发时固定邮箱验证写权限门，避免站点注册模式切换影响既有账号 */
  emailVerificationRequired?: boolean;
  /** 邀请制必填；开放注册传 null */
  invite: string | null;
}

/** 返回新用户 id；用户名/邮箱已被占用抛 RegisterError；邀请码无效/过期/已用抛 RegisterError */
export async function registerUser(input: RegisterInput): Promise<number> {
  try {
    return await getWebDb().transaction(async (tx) => {
      const inserted = await tx.insert(users).values({
        username: input.username,
        usernameKey: normalizeKey(input.username),
        email: input.email,
        emailKey: normalizeKey(input.email),
        passwordHash: input.passwordHash,
        emailVerificationRequired: input.emailVerificationRequired ?? false,
        createdAt: sql`NOW()`,
      });
      const id = Number((inserted as unknown as [{ insertId: number }])[0].insertId);
      await tx.insert(userProfiles).values({ userId: id });
      // 统计行与用户同事务建立（M6.1）：写路径要在持有这一行的锁时检查配额、维护计数，行必须一开始就存在；
      // 迁移用户已有行，新注册用户此前没有。服务层仍用 INSERT IGNORE 兜底，覆盖更早注册的、没有这一行的用户
      await tx.insert(userStats).values({ userId: id });
      if (input.invite !== null) {
        const redeemed = await tx
          .update(inviteCodes)
          .set({ usedBy: id, usedAt: sql`NOW()` })
          .where(
            and(
              eq(inviteCodes.code, input.invite),
              sql`${inviteCodes.usedBy} IS NULL`,
              sql`(${inviteCodes.expiresAt} IS NULL OR ${inviteCodes.expiresAt} > NOW())`,
            ),
          );
        // 原子核销：并发复用同一邀请码时，只有一个事务能把 used_by 从 NULL 改掉
        if ((redeemed as unknown as [{ affectedRows: number }])[0]?.affectedRows !== 1) {
          throw new InviteCodeError();
        }
      }
      return id;
    });
  } catch (e) {
    if (isDuplicateKey(e)) throw new RegisterError("用户名或邮箱已被使用");
    throw e;
  }
}
