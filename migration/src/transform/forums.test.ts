import { describe, expect, it } from "vitest";
import { deriveReadPolicy, deriveWritePolicy, transformForums, type OldForum } from "./forums.js";

// 旧库实测的三种白名单模式（会员组 8–13,28–33；管理员 3,4,5；团队 18,38,21,23,37,36）
const MEMBERS = "8,9,10,11,12,13,28,29,30,31,32,33";
const STAFF = "3,4,5,18,38,21,23,37,36";
const EVERYONE = `${MEMBERS},${STAFF},1,2,6,7`;

const f = (over: Partial<OldForum> & { fid: number }): OldForum => ({
  parentid: 0,
  type: "forum",
  name: `版块${over.fid}`,
  descrip: null,
  vieworder: 0,
  isshow: 1,
  icon: "",
  allow_read: EVERYONE,
  allow_post: `${MEMBERS},${STAFF}`,
  allow_reply: `${MEMBERS},${STAFF}`,
  ...over,
});

describe("读/写策略推导", () => {
  it("读：含游客 → public；含会员 → members；只有团队 → restricted；空 → inherit", () => {
    expect(deriveReadPolicy([2, 3, 18])).toBe("public");
    expect(deriveReadPolicy([8, 3, 18])).toBe("members");
    expect(deriveReadPolicy([3, 4, 5, 18])).toBe("restricted");
    expect(deriveReadPolicy([])).toBe("inherit");
  });

  it("写：含会员 → inherit（默认）；只有团队 → restricted；空 → inherit", () => {
    expect(deriveWritePolicy([8, 3])).toBe("inherit");
    expect(deriveWritePolicy([3, 18])).toBe("restricted");
    expect(deriveWritePolicy([])).toBe("inherit");
  });
});

describe("transformForums · 层级", () => {
  it("path / depth 沿父链生成，深度不设上限（旧站实际 4 层）", () => {
    const r = transformForums([
      f({ fid: 98, type: "category" }),
      f({ fid: 130, parentid: 98 }),
      f({ fid: 129, parentid: 130, type: "sub" }),
      f({ fid: 53, parentid: 129, type: "sub2" }),
    ]);
    const by = new Map(r.forums.map((x) => [x.id, x]));
    expect(by.get(98)).toMatchObject({ path: "/98/", depth: 1, kind: "section" });
    expect(by.get(53)).toMatchObject({ path: "/98/130/129/53/", depth: 4, kind: "forum" });
    expect(by.get(129)?.parentId).toBe(130);
  });

  it("输入乱序也能正确解析（子在父之前）", () => {
    const r = transformForums([
      f({ fid: 3, parentid: 2 }),
      f({ fid: 2, parentid: 1 }),
      f({ fid: 1 }),
    ]);
    expect(new Map(r.forums.map((x) => [x.id, x.path])).get(3)).toBe("/1/2/3/");
  });

  it("父版块缺失或成环：降级为根并记录", () => {
    const r = transformForums([
      f({ fid: 5, parentid: 999 }),
      f({ fid: 7, parentid: 8 }),
      f({ fid: 8, parentid: 7 }),
    ]);
    expect(r.stats.orphanParents).toEqual([5]);
    expect(r.stats.cycles.length).toBeGreaterThan(0);
    const by = new Map(r.forums.map((x) => [x.id, x]));
    expect(by.get(5)).toMatchObject({ parentId: 0, path: "/5/", depth: 1 });
    for (const id of r.stats.cycles) expect(by.get(id)?.parentId).toBe(0);
  });
});

describe("transformForums · 字段", () => {
  it("名称剥离内嵌 HTML；回收站标记归档；is_listed 来自 isshow", () => {
    const r = transformForums([
      f({ fid: 1, name: '<span style="color:#cb4042">『动画』</span>' }),
      f({ fid: 2, name: "回收站" }),
      f({ fid: 3, isshow: 0 }),
    ]);
    const by = new Map(r.forums.map((x) => [x.id, x]));
    expect(by.get(1)?.name).toBe("『动画』");
    expect(by.get(2)?.isArchived).toBe(true);
    expect(by.get(3)?.isListed).toBe(false);
    expect(r.stats.styledNames).toBe(1);
    expect(r.stats.archived).toBe(1);
  });

  it("排序、描述、图标", () => {
    const r = transformForums([f({ fid: 1, vieworder: 7, descrip: "说明", icon: "a.png" })]);
    expect(r.forums[0]).toMatchObject({ sortOrder: 7, description: "说明", icon: "a.png" });
    expect(transformForums([f({ fid: 2, descrip: "" })]).forums[0]?.description).toBeNull();
  });
});

describe("transformForums · 策略与作用域授权", () => {
  it("公开版块：public + 无作用域授权", () => {
    const r = transformForums([f({ fid: 1 })]);
    expect(r.forums[0]).toMatchObject({ readPolicy: "public", writePolicy: "inherit" });
    expect(r.grants).toEqual([]);
  });

  it("团队专属版块：read/write 都是 restricted，各团队角色在该版块获得读写授权（admin 不落行）", () => {
    const r = transformForums([
      f({ fid: 121, allow_read: STAFF, allow_post: STAFF, allow_reply: STAFF }),
    ]);
    expect(r.forums[0]).toMatchObject({ readPolicy: "restricted", writePolicy: "restricted" });
    const roles = (perm: string) =>
      r.grants
        .filter((g) => g.permissionKey === perm)
        .map((g) => g.roleKey)
        .sort();
    const team = [
      "team-art",
      "team-intern",
      "team-planning",
      "team-resource",
      "team-subtitle",
      "team-tech",
    ];
    expect(roles("forum.read")).toEqual(team);
    expect(roles("forum.write")).toEqual(team);
    expect(r.grants.every((g) => g.scopeId === 121)).toBe(true);
    expect(r.grants.some((g) => g.roleKey === "admin")).toBe(false);
  });

  it("旧数据 gid 23=实习组、38=策划组（v1 曾映射反）", () => {
    const r = transformForums([
      f({ fid: 1, allow_read: "23", allow_post: "38", allow_reply: "38" }),
    ]);
    expect(r.grants).toContainEqual({
      roleKey: "team-intern",
      permissionKey: "forum.read",
      scopeId: 1,
    });
    expect(r.grants).toContainEqual({
      roleKey: "team-planning",
      permissionKey: "forum.write",
      scopeId: 1,
    });
  });

  it("白名单里没有对应角色的 gid（如 40）计入未映射统计，不阻断", () => {
    const r = transformForums([
      f({ fid: 1, allow_read: "3,40", allow_post: "3,40", allow_reply: "3" }),
    ]);
    expect(r.stats.unmappedGids.get(40)).toBe(2);
  });

  it("发帖与回复白名单取并集", () => {
    const r = transformForums([f({ fid: 1, allow_post: "3", allow_reply: `${MEMBERS},3` })]);
    expect(r.forums[0]?.writePolicy).toBe("inherit");
  });
});
