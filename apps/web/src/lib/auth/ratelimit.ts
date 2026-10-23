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

/** 仅测试使用 */
export function resetRateLimiter(): void {
  buckets.clear();
}
