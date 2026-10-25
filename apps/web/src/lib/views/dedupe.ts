/**
 * 浏览量的去重（M6.5b，D3）：同一访客在窗口内只计一次。纯内存、有上限，时钟由调用方注入（便于测试）。
 * 访客 key 由调用方给出：登录用户为 `u:<id>`，游客为 IP（或 UA）的哈希。单实例语义（M13 换共享存储）。
 */
export const VIEW_DEDUPE_MS = 30 * 60_000;
const MAX_KEYS = 100_000;

export class ViewDedupe {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs = VIEW_DEDUPE_MS,
    private readonly maxKeys = MAX_KEYS,
  ) {}

  /** true = 应当计数（窗口内首次）；false = 窗口内已计过 */
  admit(key: string, now: number): boolean {
    const last = this.seen.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    // 删后再插：Map 的迭代顺序即插入顺序，超限时淘汰最早的键
    this.seen.delete(key);
    this.seen.set(key, now);
    if (this.seen.size > this.maxKeys) this.prune(now);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private prune(now: number): void {
    for (const [k, t] of this.seen) {
      if (now - t >= this.windowMs) this.seen.delete(k);
    }
    for (const k of this.seen.keys()) {
      if (this.seen.size <= this.maxKeys) break;
      this.seen.delete(k);
    }
  }
}
