/**
 * 浏览量的批量写入（M6.5b，D2）：计数先在进程内累加，定时把「主题 → 增量」批量写库。
 * 写库失败时把增量退回队列，下一轮再试（浏览量是估计值，但不丢数）。单实例语义（M13 换共享计数）。
 */
export interface ViewDelta {
  threadId: number;
  count: number;
}

export class ViewCounter {
  private pending = new Map<number, number>();

  constructor(private readonly write: (rows: ViewDelta[]) => Promise<void>) {}

  add(threadId: number, count = 1): void {
    this.pending.set(threadId, (this.pending.get(threadId) ?? 0) + count);
  }

  /** 待写入的增量总数（观测与测试用） */
  get pendingTotal(): number {
    let n = 0;
    for (const v of this.pending.values()) n += v;
    return n;
  }

  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch: ViewDelta[] = [...this.pending].map(([threadId, count]) => ({ threadId, count }));
    this.pending = new Map();
    try {
      await this.write(batch);
    } catch (e) {
      // 退回队列：与进程内新增的计数合并
      for (const { threadId, count } of batch) this.add(threadId, count);
      throw e;
    }
  }
}
