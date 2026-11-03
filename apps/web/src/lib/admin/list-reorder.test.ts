import { describe, expect, it } from "vitest";
import { moveWithinList } from "./list-reorder";

describe("列表上下移排序计划", () => {
  it.each([{ rows: [] }, { rows: [{ id: 1, sort: 0 }] }])(
    "未找到目标时保留输入 $rows",
    ({ rows }) => {
      expect(moveWithinList(rows, 9, "up")).toEqual({
        kind: "missing",
        ordered: rows,
        updates: [],
      });
    },
  );
  it.each(["up", "down"] as const)("单项 %s 不重新编号", (direction) => {
    const rows = [{ id: 1, sort: 0 }];
    expect(moveWithinList(rows, 1, direction)).toEqual({
      kind: "unchanged",
      ordered: rows,
      updates: [],
    });
  });
  it("首项上移与末项下移不重编号，即使既有 sort 不连续", () => {
    const rows = [
      { id: 1, sort: 0 },
      { id: 2, sort: 50 },
    ];
    for (const [id, direction] of [
      [1, "up"],
      [2, "down"],
    ] as const) {
      expect(moveWithinList(rows, id, direction)).toEqual({
        kind: "unchanged",
        ordered: rows,
        updates: [],
      });
    }
  });
  it("重复 sort 的有效移动按展示顺序交换，并重编号全部变化项", () => {
    const rows = Object.freeze([
      Object.freeze({ id: 10, sort: 0, name: "甲" }),
      Object.freeze({ id: 20, sort: 0, name: "乙" }),
      Object.freeze({ id: 30, sort: 3, name: "丙" }),
    ]);
    const result = moveWithinList(rows, 20, "up");
    expect(result.kind).toBe("moved");
    expect(result.ordered.map((row) => row.id)).toEqual([20, 10, 30]);
    expect(result.updates).toEqual([
      { id: 20, sort: 1 },
      { id: 10, sort: 2 },
    ]);
    expect(result.ordered[0]).toBe(rows[1]);
    expect(rows.map((row) => [row.id, row.sort])).toEqual([
      [10, 0],
      [20, 0],
      [30, 3],
    ]);
  });
  it.each([
    [1, "down", [2, 1, 3]],
    [3, "up", [1, 3, 2]],
  ] as const)("%s %s 只写变化的两项", (id, direction, expected) => {
    const rows = [1, 2, 3].map((id) => ({ id, sort: id }));
    const result = moveWithinList(rows, id, direction);
    expect(result.ordered.map((row) => row.id)).toEqual(expected);
    expect(result.updates).toHaveLength(2);
    for (const update of result.updates) expect(expected[update.sort - 1]).toBe(update.id);
  });
});
