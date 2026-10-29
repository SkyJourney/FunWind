import { describe, expect, it } from "vitest";
import { childPath, depthOf, planMove } from "./admin";
import type { ForumNode as Node } from "./forum-tree";

/**
 * planMove / path helpers 纯逻辑（M10.6a）：环检测、子树 path/depth 重算、根迁移。
 * admin.ts 顶层只做惰性依赖声明（getWebDb 单例在调用时才连库），纯函数可直测。
 */

const node = (id: number, parentId: number, path: string, kind: Node["kind"] = "forum"): Node => ({
  id,
  parentId,
  path,
  depth: depthOf(path),
  kind,
  name: `版块${id}`,
  description: null,
  iconKey: null,
  sortOrder: id,
  readPolicy: "inherit",
  writePolicy: "inherit",
  reviewPolicy: "inherit",
  isListed: true,
  isArchived: false,
});

const ROWS: Node[] = [
  node(1, 0, "/1/", "section"), // 分区 A
  node(2, 1, "/1/2/"), // A 下的版块 B
  node(3, 2, "/1/2/3/"), // B 下的子版块 C
  node(4, 0, "/4/"), // 顶级版块 D
];

describe("childPath / depthOf", () => {
  it("根与嵌套路径拼接", () => {
    expect(childPath("/", 7)).toBe("/7/");
    expect(childPath("/1/2/", 3)).toBe("/1/2/3/");
    expect(depthOf("/7/")).toBe(1);
    expect(depthOf("/1/2/3/")).toBe(3);
    expect(depthOf("/")).toBe(0);
  });
});

describe("planMove", () => {
  it("子树整体迁移：path/depth/parentId 重算", () => {
    const plan = planMove(ROWS, 2, 4);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.updates).toEqual([
      { id: 2, parentId: 4, path: "/4/2/", depth: 2 },
      { id: 3, parentId: 2, path: "/4/2/3/", depth: 3 },
    ]);
  });

  it("迁到顶级：根路径约定 /{fid}/", () => {
    const plan = planMove(ROWS, 2, 0);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.updates.map((u) => [u.id, u.path, u.depth])).toEqual([
      [2, "/2/", 1],
      [3, "/2/3/", 2],
    ]);
  });

  it("环检测：目标在自己子树内（含自身）被拒", () => {
    expect(planMove(ROWS, 1, 3)).toEqual({ ok: false, code: "cycle" });
    expect(planMove(ROWS, 2, 3)).toEqual({ ok: false, code: "cycle" });
    expect(planMove(ROWS, 2, 2)).toEqual({ ok: false, code: "cycle" });
  });

  it("不存在的版块或父级", () => {
    expect(planMove(ROWS, 99, 0)).toEqual({ ok: false, code: "not_found" });
    expect(planMove(ROWS, 2, 99)).toEqual({ ok: false, code: "not_found" });
  });
});
