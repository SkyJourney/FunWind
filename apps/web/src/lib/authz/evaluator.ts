import { permissionSatisfies, PERMISSION_DEFINITIONS } from "@funwind/db";
import type { AuthzSnapshot, Decision, GrantRow, Subject } from "./types";

/**
 * 权限评估器（纯函数，零 SQL）。顺序与语义见 docs/AUTHZ.md §8.3：
 *   未知权限点 → admin 短路 → 用户限制 → 开放注册未验证邮箱 → 按权限点类型分派
 *   forum.read   ：沿版块树取最近的非 inherit read_policy（public / members / restricted）
 *   forum.write  ：先过读判定，再取 write_policy（restricted 须在版块作用域持有授权，全局基线不算）；
 *                  目标是分区（kind=section）或自身 / 祖先已归档 → 一律拒绝（**含 admin**，在 admin 短路之前判定）；
 *                  回帖且主题已锁定 → 还须持有 thread.replyLocked
 *   其余（含 forum.moderate）：级联合并——适用作用域内任一授权命中即允许
 * 默认拒绝；评估器不内置“游客可读/会员可写”之类硬编码默认值（读靠策略默认公开，写靠基线授权）。
 */

/**
 * 写类权限：会产生内容或社交副作用的动作。禁言/封禁与“开放注册未验证邮箱”拦的就是这一类。
 * 浏览、举报、参与投票、查看投票结果不在其中——禁言不应妨碍举报与投票。
 */
export const WRITE_CLASS_KEYS: ReadonlySet<string> = new Set([
  "forum.write",
  "thread.replyLocked",
  "gate.points",
  "gate.reply",
  "attachment.upload",
  "vote.create",
  "pm.send",
  "tag.add",
  "tag.edit",
  "tag.manage",
]);

/** 非写类权限（显式列出，使词汇表里每个键都有明确归类；见单测的完备性断言） */
export const NON_WRITE_CLASS_KEYS: ReadonlySet<string> = new Set([
  "site.visit",
  "site.admin",
  "admin.roles",
  "admin.users",
  "admin.reports",
  "admin.logs",
  "admin.recycle",
  "forum.read",
  "forum.moderate",
  "forum.report",
  "attachment.download",
  "vote.participate",
  "vote.view",
  "sign.use",
  "user.viewIp",
]);

const KNOWN_KEYS: ReadonlySet<string> = new Set(PERMISSION_DEFINITIONS.map((p) => p.key));

const allow = (reason: string): Decision => ({ allowed: true, reason });
const deny = (reason: string): Decision => ({ allowed: false, reason });

export interface EvalContext {
  /** 版块作用域；缺省为站点级 */
  forumId?: number;
  /**
   * 回帖目标主题是否已锁定（M6.1）。为 true 时，`forum.write` 在通过版块层判定之后还须持有 `thread.replyLocked`。
   * 只对 `forum.write` 有意义，其他权限点忽略它；调用方（写路径服务）在事务内重读主题后传入，不信任事务外读到的旧值。
   */
  threadLocked?: boolean;
}

export function evaluate(
  subject: Subject,
  permissionKey: string,
  ctx: EvalContext,
  snap: AuthzSnapshot,
): Decision {
  if (!KNOWN_KEYS.has(permissionKey)) return deny(`未知权限点: ${permissionKey}`);

  const { tree } = snap;
  if (ctx.forumId !== undefined && !tree.has(ctx.forumId)) return deny("版块不存在");
  const chain = ctx.forumId !== undefined ? tree.chain(ctx.forumId) : [];
  /** 作用域是否适用：全局恒适用；版块作用域仅当目标版块位于其子树内 */
  const applies = (scopeId: number): boolean => scopeId === 0 || chain.includes(scopeId);

  // 0.5 容器与冻结：分区只是容器、归档版块已冻结，往里写没有意义（会产生无处展示的孤儿内容）。
  //     放在 admin 短路之前——admin 也不例外；想写先取消归档。版主操作（forum.moderate）不受影响。
  if (permissionKey === "forum.write" && ctx.forumId !== undefined) {
    if (tree.get(ctx.forumId)?.kind === "section") return deny("分区不可发帖");
    if (chain.some((id) => tree.get(id)?.isArchived)) return deny("版块已归档");
  }

  // 1. admin 短路（角色绑定本身也受作用域约束）
  const held = new Set(subject.roles.filter((r) => applies(r.scopeId)).map((r) => r.key));
  if (held.has("admin")) return allow("admin");

  // 2. 用户限制优先于任何授权
  const isWrite = WRITE_CLASS_KEYS.has(permissionKey);
  for (const r of subject.restrictions) {
    if (!applies(r.scopeId)) continue;
    if (isWrite && (r.kind === "ban" || r.kind === "mute")) {
      return deny(r.kind === "ban" ? "账号已被封禁" : "账号处于禁言状态");
    }
    if (r.kind === "no_signature" && permissionKey === "sign.use") {
      return deny("账号被禁止使用签名档");
    }
  }

  // 3. 开放注册模式下，邮箱未验证的登录用户不得执行写类动作（邀请制不受影响）
  if (
    isWrite &&
    subject.userId !== null &&
    subject.registerMode === "open" &&
    !subject.emailVerified
  ) {
    return deny("请先验证邮箱");
  }

  /** 持有（适用作用域内）满足该权限点的授权；scopeFilter 可进一步限定授权的作用域 */
  const hasGrant = (key: string, scopeFilter: (scopeId: number) => boolean): boolean =>
    [...held].some((role) =>
      (snap.grantsByRole.get(role) ?? []).some(
        (g: GrantRow) =>
          applies(g.scopeId) && scopeFilter(g.scopeId) && permissionSatisfies(g.permissionKey, key),
      ),
    );
  /** 仅版块作用域（scope>0）的授权；全局基线不算 */
  const forumScoped = (s: number): boolean => s > 0;
  const anyScope = (): boolean => true;

  // 4. 按权限点类型分派
  if (permissionKey === "forum.read") {
    if (ctx.forumId === undefined) return allow("站点默认公开");
    return readDecision(subject, ctx.forumId, snap, (k) => hasGrant(k, forumScoped));
  }

  if (permissionKey === "forum.write" && ctx.forumId !== undefined) {
    const read = readDecision(subject, ctx.forumId, snap, (k) => hasGrant(k, forumScoped));
    if (!read.allowed) return deny("无权访问该版块");
    const policy = tree.writePolicy(ctx.forumId);
    let decision: Decision;
    if (policy.value === "restricted") {
      decision = hasGrant("forum.write", forumScoped)
        ? allow("版块发帖授权")
        : deny("该版块仅限授权角色发帖");
    } else {
      decision = hasGrant("forum.write", anyScope) ? allow("授权") : deny("无发帖权限");
    }
    // 主题已锁定：普通发帖授权不够，还须 thread.replyLocked（admin 已在上面短路放行）
    if (decision.allowed && ctx.threadLocked && !hasGrant("thread.replyLocked", anyScope)) {
      return deny("主题已锁定");
    }
    return decision;
  }

  // 级联合并：适用作用域（全局 ∪ 链上）内任一授权命中即允许（含级别隐含，如 moderate ⊃ write ⊃ read）
  return hasGrant(permissionKey, anyScope) ? allow("授权") : deny("默认拒绝");
}

/** 读判定：public 任何人；members 须登录；restricted 须在版块作用域持有 forum.read（或更高级别）授权 */
function readDecision(
  subject: Subject,
  forumId: number,
  snap: AuthzSnapshot,
  hasScopedGrant: (key: string) => boolean,
): Decision {
  const policy = snap.tree.readPolicy(forumId);
  switch (policy.value) {
    case "public":
      return allow("公开版块");
    case "members":
      return subject.userId !== null ? allow("会员可读") : deny("该版块仅限登录会员");
    case "restricted":
      return hasScopedGrant("forum.read") ? allow("版块读授权") : deny("该版块仅限授权角色");
  }
}

// ---------- 内容可见性 ----------

export type ContentState = "visible" | "pending" | "rejected" | "hidden" | "deleted";

/**
 * 内容可见性矩阵（docs/DESIGN-MODEL.md §4）。调用方须已通过 forum.read 判定。
 *   visible            → 所有人
 *   pending / rejected → 作者本人 + 持有 forum.moderate 的版主
 *   hidden / deleted   → 仅版主；对其他人表现为不存在
 */
export function contentVisibleTo(
  subject: Subject,
  content: { state: ContentState; authorId: number; forumId: number },
  snap: AuthzSnapshot,
): boolean {
  if (content.state === "visible") return true;
  const moderator = evaluate(subject, "forum.moderate", { forumId: content.forumId }, snap).allowed;
  if (content.state === "pending" || content.state === "rejected") {
    return moderator || (subject.userId !== null && subject.userId === content.authorId);
  }
  return moderator;
}

/** 主体可读的版块 id（查询层据此在取数前过滤，杜绝受限版块的标题/计数泄露） */
export function readableForumIds(subject: Subject, snap: AuthzSnapshot): number[] {
  return snap.tree
    .all()
    .filter((n) => evaluate(subject, "forum.read", { forumId: n.id }, snap).allowed)
    .map((n) => n.id);
}

/** 主体持有 forum.moderate 的版块 id（可见 pending/rejected/hidden/deleted 内容的范围） */
export function moderatedForumIds(subject: Subject, snap: AuthzSnapshot): number[] {
  return snap.tree
    .all()
    .filter((n) => evaluate(subject, "forum.moderate", { forumId: n.id }, snap).allowed)
    .map((n) => n.id);
}
