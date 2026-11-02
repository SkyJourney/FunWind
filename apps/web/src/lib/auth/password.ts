import { createHash, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/**
 * 密码哈希：argon2id（基线审查级约定）。
 * 双轨（docs/PASSWORD-DUAL-TRACK.md）：迁移账号的旧站哈希材料存 legacy_password_hash，
 * 旧密码可登录一次并强制换新密；旧算法口径取自旧站源码 WindidUtility::buildPassword
 * （md5(md5(明文) + salt)，salt 6 位，登录走 nw_windid_user）。
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

export type PasswordVerifier = (hashValue: string, password: string) => Promise<boolean>;

// 按 ARGON2_OPTS 预生成；无需保密，且避免首次缺失账号请求额外执行一次哈希生成。
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$14yv8q9fcTAnJKMj2J7CjQ$En35z/bWHh+DrqTGdIy3TAcdkcb1a7jEUD5JZ33e77U";

/** 标识符密码复验统一执行一次现代哈希校验；无现代哈希时用假哈希且绝不接受其命中。 */
export async function verifyAccountPassword(
  hashValue: string | null,
  password: string,
  verifier: PasswordVerifier = verifyPassword,
): Promise<boolean> {
  const realHash = hashValue || null;
  const matched = await verifier(realHash ?? DUMMY_PASSWORD_HASH, password);
  return realHash !== null && matched;
}

const md5Hex = (s: string): string => createHash("md5").update(s, "utf8").digest("hex");

/** 旧站哈希材料入库格式：`md5$<hash>$<salt>`（唯一写入方 = 迁移回填脚本） */
export function buildLegacyStorage(hashHex: string, salt: string): string {
  return `md5$${hashHex}$${salt}`;
}

/** 旧站算法构造（与 buildPassword 同口径；回填脚本与单测共用） */
export function legacyHashHex(plaintext: string, salt: string): string {
  return md5Hex(md5Hex(plaintext) + salt);
}

/** 双轨校验：材料格式坏/截断一律 false；比较走常数时间 */
export function verifyLegacyPassword(stored: string, password: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "md5" || parts[1].length !== 32 || parts[2] === "") {
    return false;
  }
  const candidate = Buffer.from(legacyHashHex(password, parts[2]), "hex");
  const expect = Buffer.from(parts[1], "hex");
  return candidate.length === expect.length && timingSafeEqual(candidate, expect);
}
