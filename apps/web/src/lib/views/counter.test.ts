import { describe, expect, it, vi } from "vitest";
import { ViewCounter } from "./counter";

describe("ViewCounter", () => {
  it("同一主题的增量合并后批量写入，写入后清空", async () => {
    const write = vi.fn(async () => {});
    const c = new ViewCounter(write);
    c.add(1);
    c.add(1);
    c.add(2, 5);
    expect(c.pendingTotal).toBe(7);
    await c.flush();
    expect(write).toHaveBeenCalledWith(
      expect.arrayContaining([
        { threadId: 1, count: 2 },
        { threadId: 2, count: 5 },
      ]),
    );
    expect(c.pendingTotal).toBe(0);
    await c.flush();
    expect(write).toHaveBeenCalledTimes(1); // 没有待写入时不调用
  });

  it("写入失败：增量退回队列，下一轮再写（不丢数）", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(undefined);
    const c = new ViewCounter(write);
    c.add(3, 4);
    await expect(c.flush()).rejects.toThrow("db down");
    expect(c.pendingTotal).toBe(4);
    c.add(3);
    await c.flush();
    expect(write).toHaveBeenLastCalledWith([{ threadId: 3, count: 5 }]);
  });
});
