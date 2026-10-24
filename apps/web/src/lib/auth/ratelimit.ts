/**
 * 进程内滑动窗口频控（M4）。
 * 约束：单实例语义——多实例部署（M13）时替换为 Redis 实现，接口保持不变。
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/** key 内 windowMs 时间窗最多 max 次 */
export function rateLimit(
  key: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

  if (bucket.hits.length >= max) {
    const oldest = bucket.hits[0]!;
    buckets.set(key, bucket);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
    };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);
  // 防泄漏：低频清理（每 256 次调用扫一次过期桶）
  if (buckets.size > 4096 && Math.random() < 1 / 256) {
    for (const [k, b] of buckets) {
      if (b.hits.every((t) => now - t >= windowMs)) buckets.delete(k);
    }
  }
  return { allowed: true, remaining: max - bucket.hits.length, retryAfterSec: 0 };
}

/**
 * 退还 key 最近一次占用的额度（"先占后退"：登录成功时把为这次尝试占的额度还回去，只有失败才累计）。
 * 为什么不是"先检查、失败后再记"：argon2 校验是异步的，并发的猜测会在任何一次失败被记下之前全部通过检查，等于没有限额。
 * 先占额度再退还，并发下也严格。退还的是窗口里最新的一条，对计数而言与退还自己占的那条等价。
 */
export function rateLimitRefund(key: string): void {
  const bucket = buckets.get(key);
  if (!bucket) return;
  bucket.hits.pop();
  if (bucket.hits.length === 0) buckets.delete(key);
}

/** 仅测试使用 */
export function resetRateLimiter(): void {
  buckets.clear();
}

/** 仅测试使用：当前桶数量（验证攻击者构造的标识符不会撑大桶表） */
export function rateLimiterSize(): number {
  return buckets.size;
}
