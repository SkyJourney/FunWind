import { and, eq, or } from "drizzle-orm";
import { getWebDb, normalizeKey, users } from "@funwind/db";
import { hashPassword, verifyPassword } from "./password";
import { rateLimit, rateLimitRefund } from "./ratelimit";

/**
 * 登录判定（M5.6 S2，审查 C1 / C2）。Server Action 只负责取表单、调用本函数、按结果跳转。
 *
 * 防枚举（C1 时序）：不论用户是否存在、是否有密码，都恰好做一次 argon2 校验——
 * 不存在或密码哈希为 NULL（迁移来的账号全是）时校验一个参数相同的假哈希。旧实现在这两种情况下直接返回，
 * 比走 argon2 的账号快约 8 ms，远程取平均即可分辨"这个名字是不是已设密码的新账号"。
 *
 * 频控（C2）：三层桶，全部「先占后退」——先占额度，登录成功再退还，所以只有失败会累计，
 * 合法用户反复成功登录不会被锁；并发的猜测也无法在第一次失败入账前全部溜过检查。
 *  · IP 桶：防撞库；
 *  · (IP, 标识符) 桶：防定向爆破，且**别的 IP 刷不满它**——攻击者不能凭几次请求把受害者锁在门外。
 *    对存在与不存在的标识符一视同仁，"尝试过于频繁"因此不泄露账号是否存在；
 *  · 用户 id 总桶：防分布式爆破；用户名与邮箱归并到同一个 id，不能各猜一份。
 *    超限时**不**提示频繁（只有存在的账号会出现，等于枚举口），而是校验完照常返回「用户名或密码错误」。
 * 取不到可信 IP 时（见 lib/net/client-ip.ts）跳过 IP 桶，(IP, 标识符) 桶退化为只按标识符分桶。
 */

/** 邮箱的合法长度上限；更长的标识符不可能是任何账号，不进入桶键 */
export const MAX_IDENTIFIER_LENGTH = 254;

export const LOGIN_LIMITS = {
  /** IP 桶：每 10 分钟失败次数 */
  ip: { max: 20, windowMs: 10 * 60_000 },
  /** (IP, 标识符) 桶 */
  pair: { max: 5, windowMs: 10 * 60_000 },
  /** 用户 id 总桶 */
  user: { max: 30, windowMs: 60 * 60_000 },
} as const;

export type LoginOutcome =
  | { ok: true; userId: number }
  /** throttled：IP 桶或 (IP, 标识符) 桶超限（与账号是否存在无关）；invalid：用户名或密码错误 */
  | { ok: false; reason: "throttled" | "invalid" };

export interface LoginDeps {
  /** 密码校验（单测注入以计数；缺省 argon2id） */
  verify?: (hash: string, password: string) => Promise<boolean>;
}

/** 假哈希：与真哈希同参数，进程内只生成一次 */
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(`dummy:${Math.random()}:${Date.now()}`));

/** 用归一化键（username_key / email_key）查找；已注销账号不可登录 */
async function findUserByKey(key: string) {
  const rows = await getWebDb()
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.state, "active"), or(eq(users.usernameKey, key), eq(users.emailKey, key))))
    .limit(1);
  return rows[0] ?? null;
}

export async function attemptLogin(
  input: { identifier: string; password: string; ip: string | null },
  deps: LoginDeps = {},
): Promise<LoginOutcome> {
  const verify = deps.verify ?? verifyPassword;
  const identifier = input.identifier.trim();
  const identKey = identifier.length <= MAX_IDENTIFIER_LENGTH ? normalizeKey(identifier) : null;

  // 占额度。IP 桶与 (IP, 标识符) 桶对所有标识符一视同仁，超限即拒绝，不再往下做任何与账号有关的事
  const held: string[] = [];
  const take = (key: string, limit: { max: number; windowMs: number }): boolean => {
    const ok = rateLimit(key, limit.max, limit.windowMs).allowed;
    if (ok) held.push(key);
    return ok;
  };
  const ipOk = input.ip === null || take(`login-ip:${input.ip}`, LOGIN_LIMITS.ip);
  const pairOk =
    identKey === null || take(`login-pair:${input.ip ?? "-"}:${identKey}`, LOGIN_LIMITS.pair);
  if (!ipOk || !pairOk) return { ok: false, reason: "throttled" };

  const user = identKey === null ? null : await findUserByKey(identKey);
  const userOk = user === null || take(`login-user:${user.id}`, LOGIN_LIMITS.user);

  // 恒做一次校验：没有可校验的真哈希就校验假哈希
  const realHash = user?.passwordHash ?? null;
  const matched = await verify(realHash ?? (await getDummyHash()), input.password);

  if (user !== null && realHash !== null && matched && userOk) {
    for (const key of held) rateLimitRefund(key); // 成功不占额度
    return { ok: true, userId: user.id };
  }
  return { ok: false, reason: "invalid" };
}
