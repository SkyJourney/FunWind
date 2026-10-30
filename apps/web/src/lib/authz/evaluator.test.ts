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
    iconKey: "",
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
  g("global-mod", "forum.moderate"),
  g("admin", "user.viewIp"),
  g("site-admin", "site.admin"),
]);

const user = (
  roles: RoleBinding[] = [],
  over: Partial<Subject> & { restrictions?: Restriction[] } = {},
): Subject => ({
  userId: 100,
  roles: [{ key: "member", scopeId: 0 }, ...roles],
  restrictions: [],
  emailVerified: true,
  emailVerificationRequired: false,
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

  it("user.viewIp 不继承 site.admin 短路，必须有独立授权", () => {
    const siteAdmin = user([role("site-admin")]);
    expect(ok(siteAdmin, "site.admin")).toBe(true);
    expect(ok(siteAdmin, "user.viewIp")).toBe(false);
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

  it("全局版主不能借管理权限读取 restricted 内容；管理需要同时可读", () => {
    const globalModerator = user([role("global-mod")]);
    expect(ok(globalModerator, "forum.moderate", 2)).toBe(true);
    expect(ok(globalModerator, "forum.moderate", 3)).toBe(false);
    expect(ok(user([role("section-mod")]), "forum.moderate", 3)).toBe(true);
  });

  it("全局授权作基线（member 的 forum.report 在任何版块有效）", () => {
    expect(ok(user(), "forum.report", 2)).toBe(true);
    expect(ok(GUEST_SUBJECT, "forum.report", 2)).toBe(false);
  });
});

describe("用户限制优先于授权", () => {
  const mute = (scopeId = 0): Restriction => ({ kind: "mute", scopeId, endsAt: null });

  it("全站禁言拒绝普通写入，但不影响无版块上下文的私信、读取与举报", () => {
    const s = user([], { restrictions: [mute()] });
    for (const k of WRITE_CLASS_KEYS) {
      if (k !== "pm.send") expect(ok(s, k), k).toBe(false);
    }
    expect(ok(s, "pm.send")).toBe(true);
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

  it("全站封禁拒绝所有登录主体权限；论坛禁入按板块及子树拦读写", () => {
    const banned = user([role("admin")], {
      restrictions: [{ kind: "ban", scopeId: 0, endsAt: null }],
    });
    expect(ok(banned, "forum.read", 2)).toBe(false);
    expect(ok(banned, "site.admin")).toBe(false);

    const forumBanned = user([role("admin")], {
      restrictions: [{ kind: "forum_ban", scopeId: 3, endsAt: null }],
    });
    expect(ok(forumBanned, "forum.read", 3)).toBe(false);
    expect(ok(forumBanned, "forum.write", 5)).toBe(false);
    expect(ok(forumBanned, "forum.report", 3)).toBe(false);
    expect(ok(forumBanned, "forum.read", 2)).toBe(true);
    expect(ok(forumBanned, "pm.send")).toBe(true);
  });

  it("no_signature 拦 sign.use；no_avatar 由资料投影/上传服务处理", () => {
    const sig = user([], { restrictions: [{ kind: "no_signature", scopeId: 0, endsAt: null }] });
    expect(ok(sig, "sign.use")).toBe(false);
    expect(ok(sig, "forum.write", 2)).toBe(true);
    const av = user([], { restrictions: [{ kind: "no_avatar", scopeId: 0, endsAt: null }] });
    expect(ok(av, "sign.use")).toBe(true);
    expect(ok(av, "forum.write", 2)).toBe(true);
  });

  it("管理员不绕过禁言、签名限制或未验证邮箱写权限门", () => {
    const mutedAdmin = user([role("admin")], { restrictions: [mute()] });
    expect(ok(mutedAdmin, "forum.write", 2)).toBe(false);
    const unsignedAdmin = user([role("admin")], {
      restrictions: [{ kind: "no_signature", scopeId: 0, endsAt: null }],
    });
    expect(ok(unsignedAdmin, "sign.use")).toBe(false);
    const unverifiedAdmin = user([role("admin")], {
      emailVerified: false,
      emailVerificationRequired: true,
      registerMode: "open",
    });
    expect(ok(unverifiedAdmin, "forum.write", 2)).toBe(false);
  });
});

describe("账号级邮箱验证门", () => {
  const unverified = (mode: "open" | "invite") =>
    user([], { emailVerified: false, emailVerificationRequired: true, registerMode: mode });

  it("需要验证的未验证账号：写类拒绝，读与非写类不受影响", () => {
    const s = unverified("open");
    expect(ok(s, "forum.write", 2)).toBe(false);
    expect(ok(s, "pm.send")).toBe(false);
    expect(ok(s, "attachment.upload")).toBe(false);
    expect(ok(s, "forum.read", 2)).toBe(true);
    expect(ok(s, "forum.report", 2)).toBe(true);
  });

  it("账号级验证要求不随注册模式变化；未要求验证的账号也不受模式影响", () => {
    expect(ok(unverified("invite"), "forum.write", 2)).toBe(false);
    const optionalOpen = user([], {
      emailVerified: false,
      emailVerificationRequired: false,
      registerMode: "open",
    });
    const optionalInvite = user([], {
      emailVerified: false,
      emailVerificationRequired: false,
      registerMode: "invite",
    });
    expect(ok(optionalOpen, "forum.write", 2)).toBe(true);
    expect(ok(optionalInvite, "forum.write", 2)).toBe(true);
  });

  it("已验证的必需验证账号正常", () => {
    const s = user([], {
      emailVerified: true,
      emailVerificationRequired: true,
      registerMode: "open",
    });
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

/**
 * M6.1：写入的容器与冻结规则——分区不可发帖、归档版块冻结（含 admin）、锁定主题需 thread.replyLocked。
 * 用独立的小树，不动上面共享的测试树（共享树的集合断言按固定 id 列表写）。
 *  10 分区 ─ 11 普通版块
 *          ├ 12 归档版块 ─ 13 子版块（自身未归档，祖先已归档）
 *          └ 14 仅团队可发帖版块（write restricted）
 *  20 归档分区 ─ 21 子版块
 */
describe("写入的容器与冻结：分区 / 归档 / 主题锁定（M6.1）", () => {
  const t2 = new ForumTree([
    node(10, 0, "/10/", { kind: "section" }),
    node(11, 10, "/10/11/"),
    node(12, 10, "/10/12/", { isArchived: true }),
    node(13, 12, "/10/12/13/"),
    node(14, 10, "/10/14/", { writePolicy: "restricted" }),
    node(20, 0, "/20/", { kind: "section", isArchived: true }),
    node(21, 20, "/20/21/"),
  ]);
  const s2 = buildSnapshot(t2, [
    g("member", "site.visit"),
    g("member", "forum.write"),
    g("member", "attachment.upload"),
    g("locker", "thread.replyLocked"),
    g("team", "forum.write", 14),
    g("mod", "forum.moderate", 12),
    g("section-mod", "forum.moderate", 10),
  ]);
  const ev = (s: Subject, key: string, ctx: { forumId?: number; threadLocked?: boolean }) =>
    evaluate(s, key, ctx, s2);
  const member = user();
  const admin = user([role("admin")]);

  describe("分区（kind=section）只是容器", () => {
    it("任何人都不能往分区里写——含 admin 与持有版块写授权的角色", () => {
      for (const [who, s] of [
        ["会员", member],
        ["admin", admin],
        ["团队", user([role("team", 14)])],
        ["分区版主", user([role("section-mod", 10)])],
      ] as const) {
        const d = ev(s, "forum.write", { forumId: 10 });
        expect(d.allowed, who).toBe(false);
        expect(d.reason, who).toContain("分区");
      }
    });

    it("对照：同一分区下的普通版块可写；分区上的读 / 版主判定不受影响", () => {
      expect(ev(member, "forum.write", { forumId: 11 }).allowed).toBe(true);
      expect(ev(admin, "forum.write", { forumId: 11 }).allowed).toBe(true);
      expect(ev(member, "forum.read", { forumId: 10 }).allowed).toBe(true);
      expect(ev(user([role("section-mod", 10)]), "forum.moderate", { forumId: 10 }).allowed).toBe(
        true,
      );
      expect(ev(admin, "forum.moderate", { forumId: 10 }).allowed).toBe(true);
    });
  });

  describe("归档版块已冻结", () => {
    it("自身归档、祖先归档（子版块）、归档分区下的版块：会员与 admin 都不能写", () => {
      for (const forumId of [12, 13, 21]) {
        for (const [who, s] of [
          ["会员", member],
          ["admin", admin],
        ] as const) {
          const d = ev(s, "forum.write", { forumId });
          expect(d.allowed, `${who}@${forumId}`).toBe(false);
          expect(d.reason, `${who}@${forumId}`).toContain("归档");
        }
      }
    });

    it("对照：未归档的兄弟版块可写；归档版块上读、版主操作不受影响（版主要能处理归档内容）", () => {
      expect(ev(member, "forum.write", { forumId: 11 }).allowed).toBe(true);
      expect(ev(member, "forum.read", { forumId: 12 }).allowed).toBe(true);
      expect(ev(user([role("mod", 12)]), "forum.moderate", { forumId: 13 }).allowed).toBe(true);
      expect(ev(admin, "forum.moderate", { forumId: 13 }).allowed).toBe(true);
    });

    it("归档的判定先于写授权：团队角色在（假设）归档的受限版块也写不了", () => {
      const t3 = new ForumTree([
        node(30, 0, "/30/", { kind: "section" }),
        node(31, 30, "/30/31/", { writePolicy: "restricted", isArchived: true }),
      ]);
      const s3 = buildSnapshot(t3, [g("team", "forum.write", 31)]);
      expect(evaluate(user([role("team", 31)]), "forum.write", { forumId: 31 }, s3).allowed).toBe(
        false,
      );
    });
  });

  describe("主题锁定（threadLocked）", () => {
    it("会员回帖：未锁定可写；锁定后被拒（reason 说明是锁定）", () => {
      expect(ev(member, "forum.write", { forumId: 11, threadLocked: false }).allowed).toBe(true);
      expect(ev(member, "forum.write", { forumId: 11 }).allowed).toBe(true);
      const d = ev(member, "forum.write", { forumId: 11, threadLocked: true });
      expect(d.allowed).toBe(false);
      expect(d.reason).toContain("锁定");
    });

    it("持有 thread.replyLocked 的角色可在锁定主题回帖；admin 也可（对照：无授权者被拒）", () => {
      expect(
        ev(user([role("locker")]), "forum.write", { forumId: 11, threadLocked: true }).allowed,
      ).toBe(true);
      expect(ev(admin, "forum.write", { forumId: 11, threadLocked: true }).allowed).toBe(true);
      expect(ev(member, "forum.write", { forumId: 11, threadLocked: true }).allowed).toBe(false);
    });

    it("锁定豁免不能绕过其他拒绝：没有发帖授权、被禁言、受限版块无授权，持有 replyLocked 也不行", () => {
      const noWrite = buildSnapshot(t2, [g("locker", "thread.replyLocked")]);
      expect(
        evaluate(
          user([role("locker")]),
          "forum.write",
          { forumId: 11, threadLocked: true },
          noWrite,
        ).allowed,
      ).toBe(false);
      const muted = user([role("locker")], {
        restrictions: [{ kind: "mute", scopeId: 0, endsAt: null }],
      });
      expect(ev(muted, "forum.write", { forumId: 11, threadLocked: true }).allowed).toBe(false);
      expect(
        ev(user([role("locker")]), "forum.write", { forumId: 14, threadLocked: true }).allowed,
      ).toBe(false);
    });

    it("threadLocked 只影响 forum.write：读 / 版主 / 上传等其他权限点忽略它", () => {
      for (const key of ["forum.read", "attachment.upload", "site.visit"]) {
        expect(ev(member, key, { forumId: 11, threadLocked: true }).allowed, key).toBe(
          ev(member, key, { forumId: 11 }).allowed,
        );
      }
      expect(
        ev(user([role("mod", 12)]), "forum.moderate", { forumId: 12, threadLocked: true }).allowed,
      ).toBe(true);
    });

    it("锁定与归档同时成立时，归档优先（reason 是归档）", () => {
      const d = ev(admin, "forum.write", { forumId: 12, threadLocked: true });
      expect(d.allowed).toBe(false);
      expect(d.reason).toContain("归档");
    });
  });

  it("没有 forumId 的站点级 forum.write 判定不受分区 / 归档规则影响", () => {
    expect(ev(member, "forum.write", {}).allowed).toBe(true);
  });
});

describe("attachment.upload 须先过版块读判定（M6.4b）", () => {
  const member = user();
  const ev = (s: Subject, key: string, ctx: { forumId?: number } = {}) =>
    evaluate(s, key, ctx, snap);
  it("看不见的版块（受限、无授权）：拒绝上传，即使持有全局上传基线", () => {
    // 版块 3 为受限读：普通会员没有该版块的读授权，不能往里传文件
    expect(ev(member, "attachment.upload", { forumId: 3 }).allowed).toBe(false);
    expect(ev(member, "forum.read", { forumId: 3 }).allowed).toBe(false);
  });

  it("可读的版块：普通会员可以上传；管理员始终可以", () => {
    expect(ev(member, "attachment.upload", { forumId: 2 }).allowed).toBe(true);
    expect(ev(user([role("admin")]), "attachment.upload", { forumId: 3 }).allowed).toBe(true);
  });

  it("未指定版块（头像等无版块场景）：不做版块读判定，仅看授权", () => {
    expect(ev(member, "attachment.upload").allowed).toBe(true);
  });
});
