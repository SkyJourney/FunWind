export type MoveDirection = "up" | "down";

export interface OrderedItem {
  id: number;
  sort: number;
}

/** 输入已按展示顺序排列；越界不重编号，有效移动后只生成实际变化的连续排序计划。 */
export function moveWithinList<T extends OrderedItem>(
  rows: readonly T[],
  id: number,
  direction: MoveDirection,
): {
  kind: "missing" | "unchanged" | "moved";
  ordered: T[];
  updates: OrderedItem[];
} {
  const ordered = [...rows];
  const from = ordered.findIndex((row) => row.id === id);
  if (from < 0) return { kind: "missing", ordered, updates: [] };
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= ordered.length) return { kind: "unchanged", ordered, updates: [] };
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved!);
  const updates = ordered.flatMap((row, index) =>
    row.sort === index + 1 ? [] : [{ id: row.id, sort: index + 1 }],
  );
  return { kind: "moved", ordered, updates };
}
