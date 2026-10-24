import { describe, expect, it } from "vitest";
import { ForumTree, type ForumNode } from "./forum-tree";

/** 构造一棵测试树：
 *  1 分区(public) ─ 2 版块(inherit) ─ 4 子版块(inherit)
 *                 └ 3 受限版块(restricted/write restricted/review threads) ─ 5 子版块(inherit)
 *  6 分区(全 inherit) ─ 7 版块(members)
 */
const node = (id: number, parentId: number, over: Partial<ForumNode> = {}): ForumNode => ({
  id,
  parentId,
  path: "/",
  depth: 1,
  kind: "forum",
  name: `版块${id}`,
  description: null,
  icon: "",
  sortOrder: id,
  readPolicy: "inherit",
  writePolicy: "inherit",
  reviewPolicy: "inherit",
  isListed: true,
  isArchived: false,
  ...over,
});

const rows: ForumNode[] = [
  node(1, 0, { path: "/1/", kind: "section", readPolicy: "public" }),
  node(2, 1, { path: "/1/2/", depth: 2 }),
  node(3, 1, {
    path: "/1/3/",
    depth: 2,
    readPolicy: "restricted",
    writePolicy: "restricted",
    reviewPolicy: "threads",
  }),
  node(4, 2, { path: "/1/2/4/", depth: 3 }),
  node(5, 3, { path: "/1/3/5/", depth: 3 }),
  node(6, 0, { path: "/6/", kind: "section" }),
  node(7, 6, { path: "/6/7/", depth: 2, readPolicy: "members" }),
];
const tree = new ForumTree(rows);

describe("ForumTree · 结构", () => {
  it("根、子节点按 sortOrder 再 id 排序；all() 深度优先", () => {
    expect(tree.roots().map((n) => n.id)).toEqual([1, 6]);
    expect(tree.children(1).map((n) => n.id)).toEqual([2, 3]);
    expect(tree.all().map((n) => n.id)).toEqual([1, 2, 4, 3, 5, 6, 7]);
    expect(tree.size).toBe(7);
  });

  it("排序受 sortOrder 影响", () => {
    const t = new ForumTree([
      node(1, 0, { path: "/1/", sortOrder: 9 }),
      node(2, 0, { path: "/2/", sortOrder: 1 }),
    ]);
    expect(t.roots().map((n) => n.id)).toEqual([2, 1]);
  });

  it("作用域链：自身 → 父 → 根；不存在的节点为空", () => {
    expect(tree.chain(4)).toEqual([4, 2, 1]);
    expect(tree.chain(5)).toEqual([5, 3, 1]);
    expect(tree.chain(1)).toEqual([1]);
    expect(tree.chain(999)).toEqual([]);
  });

  it("子树含自身与全部后代，不含兄弟", () => {
    expect(tree.subtree(1)).toEqual([1, 2, 3, 4, 5]);
    expect(tree.subtree(2)).toEqual([2, 4]);
    expect(tree.subtree(7)).toEqual([7]);
    expect(tree.subtree(999)).toEqual([]);
  });

  it("环与悬空父节点不会死循环/丢子树", () => {
    const cyc = new ForumTree([node(1, 2, { path: "/1/" }), node(2, 1, { path: "/2/" })]);
    expect(cyc.chain(1)).toEqual([1, 2]);
    const orphan = new ForumTree([node(9, 404, { path: "/9/" })]);
    expect(orphan.roots().map((n) => n.id)).toEqual([9]);
    expect(orphan.chain(9)).toEqual([9]);
  });
});

describe("ForumTree · 有效策略", () => {
  it("读策略：取最近的非 inherit 祖先（含自身），并给出声明者", () => {
    expect(tree.readPolicy(2)).toEqual({ value: "public", holderId: 1 });
    expect(tree.readPolicy(4)).toEqual({ value: "public", holderId: 1 });
    expect(tree.readPolicy(3)).toEqual({ value: "restricted", holderId: 3 });
    expect(tree.readPolicy(5)).toEqual({ value: "restricted", holderId: 3 });
    expect(tree.readPolicy(7)).toEqual({ value: "members", holderId: 7 });
  });

  it("读策略：全链 inherit → 默认公开，声明者为 null", () => {
    expect(tree.readPolicy(6)).toEqual({ value: "public", holderId: null });
  });

  it("写策略：restricted 向子版块继承；全链 inherit → 默认 members", () => {
    expect(tree.writePolicy(5)).toEqual({ value: "restricted", holderId: 3 });
    expect(tree.writePolicy(4)).toEqual({ value: "members", holderId: null });
    expect(tree.writePolicy(3).value).toBe("restricted");
  });

  it("审核策略：沿链解析；全链 inherit → none", () => {
    expect(tree.reviewPolicy(3)).toEqual({ value: "threads", holderId: 3 });
    expect(tree.reviewPolicy(5)).toEqual({ value: "threads", holderId: 3 });
    expect(tree.reviewPolicy(2)).toEqual({ value: "none", holderId: null });
  });

  it("不存在的版块按默认策略（调用方应先 has() 判断）", () => {
    expect(tree.readPolicy(404)).toEqual({ value: "public", holderId: null });
  });
});
