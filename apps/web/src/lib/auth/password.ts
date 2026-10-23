import { hash, verify } from "@node-rs/argon2";

/**
 * 密码哈希：argon2id（基线审查级约定）。
 * 旧站哈希不可迁移——password_hash=NULL 的账户走 /claim 认领流程。
 */

const ARGON2_OPTS = {
  memory: 19456, // 19 MiB，OWASP 推荐
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTS);
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await verify(hashValue, password, ARGON2_OPTS);
  } catch {
    return false; // 哈希串损坏一律视为不匹配
  }
}
