import { PERMISSION_DEFINITIONS } from "@funwind/db";
import { describe, expect, it } from "vitest";
import { ForumTree, type ForumNode } from "@/lib/forums/forum-tree";
import {
  NON_WRITE_CLASS_KEYS,
  WRITE_CLASS_KEYS,
  contentVisibleTo,
  evaluate,
  moderatedForumIds,
  readableForumIds,
} from "./evaluator";
import {
  GUEST_SUBJECT,
  buildSnapshot,
  type GrantRow,
  type Restriction,
  type RoleBinding,
  type Subject,
} from "./types";

/**
 * 测试树：
 *  1 分区(read public) ─ 2 公开版块 ─ 4 公开子版块
 *                      └ 3 受限版块(read/write restricted) ─ 5 受限子版块(inherit)
 *  6 分区(全 inherit，默认公开) ─ 7 会员版块(read members)
 */
const node = (id: number, parentId: number, path: string, over: Partial<ForumNode> = {}) =>
  ({
    id,
    parentId,
    path,
    depth: path.split("/").length - 2,
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
  }) satisfies ForumNode;

const tree = new ForumTree([
  node(1, 0, "/1/", { kind: "section", readPolicy: "public" }),
  node(2, 1, "/1/2/"),
  node(3, 1, "/1/3/", { readPolicy: "restricted", writePolicy: "restricted" }),
  node(4, 2, "/1/2/4/"),
  node(5, 3, "/1/3/5/"),
  node(6, 0, "/6/", { kind: "section" }),
  node(7, 6, "/6/7/", { readPolicy: "members" }),
]);

const g = (roleKey: string, permissionKey: string, scopeId = 0): GrantRow => ({
  roleKey,
  permissionKey,
  scopeId,
});

const snap = buildSnapshot(tree, [
  g("guest", "site.visit"),
  g("guest", "vote.view"),
  g("member", "site.visit"),
  g("member", "forum.write"),
  g("member", "forum.report"),
  g("member", "pm.send"),
  g("member", "sign.use"),
  g("member", "vote.participate"),
  g("member", "attachment.upload"),
  g("team", "forum.read", 3),
  g("team", "forum.write", 3),
  g("reader", "forum.read", 3),
  g("reader", "forum.read"), // 全局读授权：对 restricted 版块不算数
  g("mod", "forum.moderate", 2),
  g("section-mod", "forum.moderate", 1),
]);

const user = (
  roles: RoleBinding[] = [],
  over: Partial<Subject> & { restrictions?: Restriction[] } = {},
): Subject => ({
  userId: 100,
  roles: [{ key: "member", scopeId: 0 }, ...roles],
  restrictions: [],
  emailVerified: true,
  registerMode: "invite",
  ...over,
});
const role = (key: string, scopeId = 0): RoleBinding => ({ key, scopeId });
const ok = (s: Subject, key: string, forumId?: number) =>
  evaluate(s, key, { forumId }, snap).allowed;

describe("词汇表完备性", () => {
  it("词汇表每个权限点都被显式归类为写类或非写类（新增权限点漏分类会红）", () => {
    const all = PERMISSION_DEFINITIONS.map((p) => p.key).sort();
    const classified = [...WRITE_CLASS_KEYS, ...NON_WRITE_CLASS_KEYS].sort();
    expect(classified).toEqual(all);
    for (const k of WRITE_CLASS_KEYS) expect(NON_WRITE_CLASS_KEYS.has(k)).toBe(false);
  });

  it("每个权限点：admin 全放行；游客与会员对无授权的权限点拒绝（词汇表全覆盖）", () => {
    const admin = user([role("admin")]);
    for (const p of PERMISSION_DEFINITIONS) {
      expect(ok(admin, p.key), p.key).toBe(true);
    }
    const bare = buildSnapshot(tree, []);
    for (const p of PERMISSION_DEFINITIONS) {
      if (p.key === "forum.read") continue; // 读由版块策略决定，不依赖授权
      expect(evaluate(user(), p.key, {}, bare).allowed, p.key).toBe(false);
      expect(evaluate(GUEST_SUBJECT, p.key, {}, bare).allowed, p.key).toBe(false);
    }
  });

  it("未知权限点一律拒绝，即使是 admin", () => {
    expect(ok(user([role("admin")]), "p1")).toBe(false);
    expect(ok(user(), "forum.manage")).toBe(false);
  });

  it("不存在的版块拒绝", () => {
    expect(ok(user([role("admin")]), "forum.read", 404)).toBe(false);
  });
});

describe("admin 短路与角色作用域", () => {
  it("全局 admin 放行一切（含受限版块与版主权限）", () => {
    const a = user([role("admin")]);
    expect(ok(a, "forum.read", 3)).toBe(true);
    expect(ok(a, "forum.moderate", 5)).toBe(true);
    expect(ok(a, "admin.roles")).toBe(true);
  });

  it("版块作用域的 admin 绑定只在该版块子树内生效", () => {
    const scoped = user([role("admin", 3)]);
    expect(ok(scoped, "forum.read", 5)).toBe(true);
    expect(ok(scoped, "forum.moderate", 3)).toBe(true);
    expect(ok(scoped, "forum.moderate", 2)).toBe(false);
    expect(ok(scoped, "admin.roles")).toBe(false); // 站点级不适用
  });

  it("角色绑定的作用域：team@3 只在 3 的子树内持有授权", () => {
    const t = user([role("team", 3)]);
    expect(ok(t, "forum.read", 3)).toBe(true);
    expect(ok(t, "forum.read", 5)).toBe(true);
    const tOther = user([role("team", 2)]); // 绑在别处：对 3 不适用
    expect(ok(tOther, "forum.read", 3)).toBe(false);
  });
});

describe("forum.read · read_policy 四取值", () => {
  it("public：游客与会员都可读；继承链上的子版块同样", () => {
    for (const fid of [1, 2, 4]) {
      expect(ok(GUEST_SUBJECT, "forum.read", fid), `fid ${fid}`).toBe(true);
      expect(ok(user(), "forum.read", fid), `fid ${fid}`).toBe(true);
    }
  });

  it("inherit 全链：默认公开", () => {
    expect(ok(GUEST_SUBJECT, "forum.read", 6)).toBe(true);
  });

  it("members：游客拒绝，登录会员允许", () => {
    expect(ok(GUEST_SUBJECT, "forum.read", 7)).toBe(false);
    expect(ok(user(), "forum.read", 7)).toBe(true);
    expect(ok(user(), "forum.read", 7)).toBe(true);
  });

  it("restricted：游客/普通会员拒绝；持有版块授权的角色允许；子版块继承受限", () => {
    expect(ok(GUEST_SUBJECT, "forum.read", 3)).toBe(false);
    expect(ok(user(), "forum.read", 3)).toBe(false);
    expect(ok(user(), "forum.read", 5)).toBe(false);
    expect(ok(user([role("team")]), "forum.read", 3)).toBe(true);
    expect(ok(user([role("team")]), "forum.read", 5)).toBe(true); // 祖先版块作用域的授权覆盖子树
  });

  it("restricted：全局读授权不算数（显式限制不会被基线击穿）", () => {
    // reader 角色同时有 scope=3 与全局的 forum.read；但只持有全局授权的角色（仿 member）不得读
    const onlyGlobal = buildSnapshot(tree, [g("member", "forum.read")]);
    expect(evaluate(user(), "forum.read", { forumId: 3 }, onlyGlobal).allowed).toBe(false);
  });

  it("restricted：更高级别授权隐含读（版主可读）", () => {
    expect(ok(user([role("section-mod")]), "forum.read", 3)).toBe(true);
  });

  it("无版块上下文的 forum.read 视为站点默认公开", () => {
    expect(ok(GUEST_SUBJECT, "forum.read")).toBe(true);
  });
});

describe("forum.write · write_policy 与读前置", () => {
  it("members/默认：会员凭全局基线可写；游客无授权拒绝", () => {
    expect(ok(user(), "forum.write", 2)).toBe(true);
    expect(ok(user(), "forum.write", 7)).toBe(true);
    expect(ok(GUEST_SUBJECT, "forum.write", 2)).toBe(false);
  });

  it("restricted：全局基线不算，须持有版块授权", () => {
    expect(ok(user(), "forum.write", 3)).toBe(false);
    expect(ok(user([role("team")]), "forum.write", 3)).toBe(true);
    expect(ok(user([role("team")]), "forum.write", 5)).toBe(true);
  });

  it("写之前先过读：读不到的版块写也被拒（即使有全局写授权）", () => {
    // 7 号是会员版块：游客读不了，也就写不了
    const guestWithWrite = buildSnapshot(tree, [g("guest", "forum.write")]);
    expect(evaluate(GUEST_SUBJECT, "forum.write", { forumId: 7 }, guestWithWrite).allowed).toBe(
      false,
    );
    // 受限版块：只有写授权没有读授权的角色 → 写授权隐含读（write ⊃ read）
    expect(ok(user([role("team")]), "forum.write", 3)).toBe(true);
  });

  it("版主授权隐含写；站点级 forum.write 走全局授权", () => {
    expect(ok(user([role("mod")]), "forum.write", 2)).toBe(true);
    expect(ok(user(), "forum.write")).toBe(true);
    expect(ok(GUEST_SUBJECT, "forum.write")).toBe(false);
  });
});

describe("级联合并（forum.moderate 与其他权限点）", () => {
  it("版主授权在版块子树内生效，不外溢到兄弟版块", () => {
    const m = user([role("mod")]);
    expect(ok(m, "forum.moderate", 2)).toBe(true);
    expect(ok(m, "forum.moderate", 4)).toBe(true); // 子版块继承
    expect(ok(m, "forum.moderate", 3)).toBe(false);
    expect(ok(m, "forum.moderate")).toBe(false); // 站点级不适用
  });

  it("分区级版主覆盖其下全部版块", () => {
    const m = user([role("section-mod")]);
    for (const fid of [2, 3, 4, 5]) expect(ok(m, "forum.moderate", fid), `fid ${fid}`).toBe(true);
    expect(ok(m, "forum.moderate", 7)).toBe(false);
  });

  it("全局授权作基线（member 的 forum.report 在任何版块有效）", () => {
    expect(ok(user(), "forum.report", 2)).toBe(true);
    expect(ok(GUEST_SUBJECT, "forum.report", 2)).toBe(false);
  });
});

describe("用户限制优先于授权", () => {
  const mute = (scopeId = 0): Restriction => ({ kind: "mute", scopeId, endsAt: null });

  it("禁言：写类全部拒绝，读/举报/参与投票不受影响", () => {
    const s = user([], { restrictions: [mute()] });
    for (const k of WRITE_CLASS_KEYS) expect(ok(s, k), k).toBe(false);
    expect(ok(s, "forum.read", 2)).toBe(true);
    expect(ok(s, "forum.report", 2)).toBe(true);
    expect(ok(s, "vote.participate")).toBe(true);
  });

  it("禁言优先于版主授权", () => {
    const s = user([role("mod")], { restrictions: [mute()] });
    expect(ok(s, "forum.write", 2)).toBe(false);
    expect(ok(s, "forum.moderate", 2)).toBe(true); // 版主权限本身不是写类
  });

  it("版块作用域的禁言只在该版块子树内生效", () => {
    const s = user([], { restrictions: [mute(2)] });
    expect(ok(s, "forum.write", 2)).toBe(false);
    expect(ok(s, "forum.write", 4)).toBe(false);
    expect(ok(s, "forum.write", 7)).toBe(true);
    expect(ok(s, "pm.send")).toBe(true); // 站点级动作不受版块禁言影响
  });

  it("封禁同样拦写类", () => {
    const s = user([], { restrictions: [{ kind: "ban", scopeId: 0, endsAt: null }] });
    expect(ok(s, "forum.write", 2)).toBe(false);
    expect(ok(s, "pm.send")).toBe(false);
  });

  it("no_signature 只拦 sign.use；no_avatar 不影响任何权限点", () => {
    const sig = user([], { restrictions: [{ kind: "no_signature", scopeId: 0, endsAt: null }] });
    expect(ok(sig, "sign.use")).toBe(false);
    expect(ok(sig, "forum.write", 2)).toBe(true);
    const av = user([], { restrictions: [{ kind: "no_avatar", scopeId: 0, endsAt: null }] });
    expect(ok(av, "sign.use")).toBe(true);
    expect(ok(av, "forum.write", 2)).toBe(true);
  });

  it("admin 不受限制约束（短路在先）", () => {
    const s = user([role("admin")], { restrictions: [mute()] });
    expect(ok(s, "forum.write", 2)).toBe(true);
  });
});

describe("开放注册 · 邮箱未验证", () => {
  const unverified = (mode: "open" | "invite") =>
    user([], { emailVerified: false, registerMode: mode });

  it("开放注册 + 未验证：写类拒绝，读与非写类不受影响", () => {
    const s = unverified("open");
    expect(ok(s, "forum.write", 2)).toBe(false);
    expect(ok(s, "pm.send")).toBe(false);
    expect(ok(s, "attachment.upload")).toBe(false);
    expect(ok(s, "forum.read", 2)).toBe(true);
    expect(ok(s, "forum.report", 2)).toBe(true);
  });

  it("邀请制：未验证不影响（迁移用户的 email_verified_at 全为空）", () => {
    const s = unverified("invite");
    expect(ok(s, "forum.write", 2)).toBe(true);
    expect(ok(s, "pm.send")).toBe(true);
  });

  it("已验证的开放注册用户正常", () => {
    const s = user([], { emailVerified: true, registerMode: "open" });
    expect(ok(s, "forum.write", 2)).toBe(true);
  });
});

describe("contentVisibleTo · 状态矩阵", () => {
  const author = user([], { userId: 7 });
  const other = user([], { userId: 8 });
  const mod = user([role("mod")], { userId: 9 });
  const c = (state: Parameters<typeof contentVisibleTo>[1]["state"], forumId = 2) => ({
    state,
    authorId: 7,
    forumId,
  });
  const see = (s: Subject, state: Parameters<typeof c>[0], forumId = 2) =>
    contentVisibleTo(s, c(state, forumId), snap);

  it("visible：所有人", () => {
    for (const s of [GUEST_SUBJECT, author, other, mod]) expect(see(s, "visible")).toBe(true);
  });

  it("pending / rejected：作者本人与版主可见，其他人与游客不可见", () => {
    for (const st of ["pending", "rejected"] as const) {
      expect(see(author, st), st).toBe(true);
      expect(see(mod, st), st).toBe(true);
      expect(see(other, st), st).toBe(false);
      expect(see(GUEST_SUBJECT, st), st).toBe(false);
    }
  });

  it("hidden / deleted：仅版主；作者本人也不可见", () => {
    for (const st of ["hidden", "deleted"] as const) {
      expect(see(mod, st), st).toBe(true);
      expect(see(author, st), st).toBe(false);
      expect(see(other, st), st).toBe(false);
    }
  });

  it("版主只对其作用域内的版块有效", () => {
    expect(see(mod, "hidden", 3)).toBe(false);
    expect(see(mod, "pending", 3)).toBe(false);
  });
});

describe("可读/可管版块集合（查询层过滤用）", () => {
  it("游客：公开版块可读，受限与会员版块不可读 → 首页聚合不会泄露", () => {
    expect(readableForumIds(GUEST_SUBJECT, snap)).toEqual([1, 2, 4, 6]);
  });

  it("普通会员：多出会员版块；仍读不到受限版块", () => {
    expect(readableForumIds(user(), snap)).toEqual([1, 2, 4, 6, 7]);
  });

  it("团队成员：多出受限版块及其子版块", () => {
    expect(readableForumIds(user([role("team")]), snap)).toEqual(
      [1, 2, 4, 3, 5, 6, 7].sort(sortLikeTree),
    );
  });

  it("admin 全部可读/可管；版主只管自己的子树；无授权者为空", () => {
    const admin = user([role("admin")]);
    expect(readableForumIds(admin, snap)).toHaveLength(7);
    expect(moderatedForumIds(admin, snap)).toHaveLength(7);
    expect(moderatedForumIds(user([role("mod")]), snap)).toEqual([2, 4]);
    expect(moderatedForumIds(user(), snap)).toEqual([]);
    expect(moderatedForumIds(GUEST_SUBJECT, snap)).toEqual([]);
  });
});

/** all() 是深度优先：1,2,4,3,5,6,7 */
function sortLikeTree(a: number, b: number): number {
  const order = [1, 2, 4, 3, 5, 6, 7];
  return order.indexOf(a) - order.indexOf(b);
}
