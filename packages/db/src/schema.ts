import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  datetime,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  text,
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * qysub_next · schema v2（M5.5，单一事实源，决策 #10）
 *
 * 设计原则（详见 docs/milestones/M5.5-schema-v2.md）：
 *  - 业务库只放新模型：不带 raw / content_raw 归档列；旧结构不渗入
 *  - 保留旧主键（uid/tid/pid/fid/aid）以保证 URL 冻结；主键均为 AUTO_INCREMENT，迁移后把起点推到旧最大值之后
 *  - 唯一键不得依赖 NULL 去重来表达作用域/层级：全局作用域用 scope_id = 0 哨兵
 *    （例外：单列、且「空值 = 没有」本身就是期望语义，如 users.email_key）
 *  - 状态是一等属性（read_policy / state / user_restrictions），不靠「有没有记录」推断
 *  - 不建外键（导入友好，参照完整性由应用层保证）；时间为 DATETIME 北京墙面值；utf8mb4 / InnoDB
 *
 * 列级排序规则：username_key / email_key 需 utf8mb4_bin（さくら≠サクラ、归一化后精确比较）。
 * drizzle-kit 不支持列级 collate，由 bootstrap 的 PATCHES 幂等补齐（见 src/bootstrap.ts）。
 */

const dt = (name: string) => datetime(name, { mode: "string" });

// ============================================================
// 身份
// ============================================================

export const users = mysqlTable(
  "users",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    /** 展示名（保留原大小写与假名） */
    username: varchar("username", { length: 64 }).notNull(),
    /** 归一化唯一键：trim + toLowerCase，不做 NFKC（半角 ｻｸﾗ 不得与 サクラ 碰撞） */
    usernameKey: varchar("username_key", { length: 64 }).notNull(),
    email: varchar("email", { length: 128 }),
    /** 邮箱归一化唯一键（小写）；NULL = 没有邮箱，多个 NULL 不冲突 */
    emailKey: varchar("email_key", { length: 128 }),
    passwordHash: varchar("password_hash", { length: 255 }),
    emailVerifiedAt: dt("email_verified_at"),
    state: mysqlEnum("state", ["active", "spam"]).notNull().default("active"),
    createdAt: dt("created_at").notNull(),
    lastLoginAt: dt("last_login_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("uq_users_username_key").on(t.usernameKey),
    uniqueIndex("uq_users_email_key").on(t.emailKey),
    index("idx_users_state").on(t.state),
    index("idx_users_created").on(t.createdAt),
  ],
);

export const userProfiles = mysqlTable(
  "user_profiles",
  {
    userId: int("user_id", { unsigned: true }).notNull(),
    bio: text("bio"),
    location: varchar("location", { length: 100 }).notNull().default(""),
    website: varchar("website", { length: 200 }).notNull().default(""),
    gender: tinyint("gender").notNull().default(0),
    birthday: date("birthday", { mode: "string" }),
    signatureMd: text("signature_md"),
    /** 头像存储键；NULL = 无头像（迁移时扫磁盘确认文件存在才填） */
    avatarKey: varchar("avatar_key", { length: 128 }),
  },
  (t) => [primaryKey({ columns: [t.userId] })],
);

/** 可由 posts 重算的用户计数缓存 */
export const userStats = mysqlTable(
  "user_stats",
  {
    userId: int("user_id", { unsigned: true }).notNull(),
    threadCount: int("thread_count", { unsigned: true }).notNull().default(0),
    postCount: int("post_count", { unsigned: true }).notNull().default(0),
    digestCount: int("digest_count", { unsigned: true }).notNull().default(0),
    followerCount: int("follower_count", { unsigned: true }).notNull().default(0),
    lastPostAt: dt("last_post_at"),
  },
  (t) => [primaryKey({ columns: [t.userId] })],
);

/** 用户限制：封禁/禁言/禁头像/禁签名统一一处（取代 muted 角色 + user_bans + 旧 status 位） */
export const userRestrictions = mysqlTable(
  "user_restrictions",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    userId: int("user_id", { unsigned: true }).notNull(),
    kind: mysqlEnum("kind", ["ban", "mute", "no_avatar", "no_signature"]).notNull(),
    /** 0 = 全站；> 0 = 版块 id */
    scopeId: int("scope_id", { unsigned: true }).notNull().default(0),
    reason: varchar("reason", { length: 255 }).notNull().default(""),
    startsAt: dt("starts_at").notNull(),
    /** NULL = 永久 */
    endsAt: dt("ends_at"),
    createdBy: int("created_by", { unsigned: true }),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] }), index("idx_ur_user_kind").on(t.userId, t.kind)],
);

export const sessions = mysqlTable(
  "sessions",
  {
    // 存 SHA-256(token)：库泄漏不等于会话劫持
    id: varchar("id", { length: 64 }).notNull(),
    userId: int("user_id", { unsigned: true }).notNull(),
    createdAt: dt("created_at").notNull(),
    expiresAt: dt("expires_at").notNull(),
    lastSeenAt: dt("last_seen_at"),
    ip: varchar("ip", { length: 64 }),
    userAgent: varchar("user_agent", { length: 255 }),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_sessions_user").on(t.userId),
    index("idx_sessions_expires").on(t.expiresAt),
  ],
);

export const emailTokens = mysqlTable(
  "email_tokens",
  {
    id: varchar("id", { length: 64 }).notNull(), // 存 SHA-256(token)
    purpose: mysqlEnum("purpose", ["reset", "verify", "claim"]).notNull(),
    userId: int("user_id", { unsigned: true }).notNull(),
    createdAt: dt("created_at").notNull(),
    expiresAt: dt("expires_at").notNull(),
    usedAt: dt("used_at"),
  },
  (t) => [primaryKey({ columns: [t.id] }), index("idx_et_user").on(t.userId, t.purpose)],
);

export const inviteCodes = mysqlTable(
  "invite_codes",
  {
    code: varchar("code", { length: 32 }).notNull(),
    createdBy: int("created_by", { unsigned: true }),
    usedBy: int("used_by", { unsigned: true }),
    usedAt: dt("used_at"),
    expiresAt: dt("expires_at"),
    batch: varchar("batch", { length: 64 }).notNull().default(""),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.code] }), index("idx_ic_batch").on(t.batch)],
);

export const siteSettings = mysqlTable(
  "site_settings",
  {
    key: varchar("key", { length: 64 }).notNull(),
    value: json("value"),
    updatedAt: dt("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.key] })],
);

// ============================================================
// 版块
// ============================================================

/**
 * 版块树：邻接表 parent_id + 物化路径 path + depth，应用启动加载为内存树 ForumTree。
 * read_policy 是一等属性（inherit 取最近的非 inherit 祖先，全无则公开）。
 */
export const forums = mysqlTable(
  "forums",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    parentId: int("parent_id", { unsigned: true }).notNull().default(0),
    /** 物化路径，含自身，如 /98/130/129/53/ */
    path: varchar("path", { length: 255 }).notNull().default("/"),
    depth: tinyint("depth", { unsigned: true }).notNull().default(1),
    /** section = 分区（不可发帖的容器）；forum = 可发帖版块 */
    kind: mysqlEnum("kind", ["section", "forum"]).notNull().default("forum"),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    icon: varchar("icon", { length: 100 }).notNull().default(""),
    sortOrder: int("sort_order").notNull().default(0),
    readPolicy: mysqlEnum("read_policy", ["inherit", "public", "members", "restricted"])
      .notNull()
      .default("inherit"),
    /**
     * 写入策略（发帖/回帖）：inherit 取最近的非 inherit 祖先（全无则 members：登录用户凭全局 forum.write 即可）；
     * restricted = 必须在该版块（或祖先版块）作用域持有 forum.write 授权，全局基线不算。
     * 旧站「只有团队组能发帖」的 6 个版块即此类；同时满足将来「只读公告版」的常见需求。
     */
    writePolicy: mysqlEnum("write_policy", ["inherit", "members", "restricted"])
      .notNull()
      .default("inherit"),
    /** 是否出现在首页目录/最新动态（旧 isshow=0 的版块仍可直达，不影响权限判定） */
    isListed: boolean("is_listed").notNull().default(true),
    isArchived: boolean("is_archived").notNull().default(false),
    /** 以下为可由 threads/posts 重算的缓存 */
    threadCount: int("thread_count", { unsigned: true }).notNull().default(0),
    postCount: int("post_count", { unsigned: true }).notNull().default(0),
    lastPostId: int("last_post_id", { unsigned: true }),
    lastPostedAt: dt("last_posted_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_forums_parent").on(t.parentId, t.sortOrder),
    index("idx_forums_path").on(t.path),
  ],
);

/** 版块主题前缀（旧 topic_type；迁移时只带被引用的） */
export const forumPrefixes = mysqlTable(
  "forum_prefixes",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    forumId: int("forum_id", { unsigned: true }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    sortOrder: smallint("sort_order").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.id] }), index("idx_fp_forum").on(t.forumId, t.sortOrder)],
);

// ============================================================
// 内容（统一 post 模型：首帖 = floor 1）
// ============================================================

export const threads = mysqlTable(
  "threads",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    forumId: int("forum_id", { unsigned: true }).notNull(),
    authorId: int("author_id", { unsigned: true }).notNull(),
    /** 仅历史孤儿作者（用户行已不存在）填写，渲染「已注销」 */
    authorNameLegacy: varchar("author_name_legacy", { length: 64 }),
    title: varchar("title", { length: 255 }).notNull(),
    prefixId: int("prefix_id", { unsigned: true }),
    kind: mysqlEnum("kind", ["normal", "poll"]).notNull().default("normal"),
    firstPostId: int("first_post_id", { unsigned: true }),
    state: mysqlEnum("state", ["visible", "hidden", "deleted", "spam"])
      .notNull()
      .default("visible"),
    topped: tinyint("topped").notNull().default(0),
    digest: tinyint("digest").notNull().default(0),
    isLocked: boolean("is_locked").notNull().default(false),
    /** 以下为可由 posts 重算的缓存（旧值不可信：reply_count 在 50 个主题上对不上） */
    replyCount: int("reply_count", { unsigned: true }).notNull().default(0),
    viewCount: int("view_count", { unsigned: true }).notNull().default(0),
    lastPostId: int("last_post_id", { unsigned: true }),
    lastPosterId: int("last_poster_id", { unsigned: true }),
    lastPostedAt: dt("last_posted_at"),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_threads_forum").on(t.forumId, t.state, t.topped, t.lastPostedAt),
    index("idx_threads_author").on(t.authorId),
    index("idx_threads_created").on(t.createdAt),
    index("idx_threads_digest").on(t.digest),
    index("idx_threads_last").on(t.state, t.lastPostedAt),
  ],
);

export const posts = mysqlTable(
  "posts",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    threadId: int("thread_id", { unsigned: true }).notNull(),
    /** 楼层：首帖 = 1；删除后不重排（允许空洞） */
    floor: int("floor", { unsigned: true }).notNull(),
    authorId: int("author_id", { unsigned: true }).notNull(),
    authorNameLegacy: varchar("author_name_legacy", { length: 64 }),
    /** 仅公开部分；门控隐藏内容拆在 post_gates.hidden_md（见 docs/GATES.md） */
    bodyMd: mediumtext("body_md"),
    replyToPostId: int("reply_to_post_id", { unsigned: true }),
    hasGate: boolean("has_gate").notNull().default(false),
    state: mysqlEnum("state", ["visible", "hidden", "deleted", "spam"])
      .notNull()
      .default("visible"),
    likeCount: int("like_count", { unsigned: true }).notNull().default(0),
    createdAt: dt("created_at").notNull(),
    editedAt: dt("edited_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("uq_posts_thread_floor").on(t.threadId, t.floor),
    index("idx_posts_author").on(t.authorId),
    index("idx_posts_reply_to").on(t.replyToPostId),
  ],
);

/**
 * 门控：内容容器 + 可插拔解锁条件（conditions JSON 数组 + match_mode）。
 * 隐藏正文只通过 getGateContent 读取；posts.body_md 永远只含占位。
 */
export const postGates = mysqlTable(
  "post_gates",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    postId: int("post_id", { unsigned: true }).notNull(),
    seq: tinyint("seq", { unsigned: true }).notNull(),
    conditions: json("conditions").notNull(),
    matchMode: mysqlEnum("match_mode", ["all", "any"]).notNull().default("all"),
    hiddenMd: mediumtext("hidden_md").notNull(),
    unlockCount: int("unlock_count", { unsigned: true }).notNull().default(0),
    createdAt: dt("created_at").notNull(),
    updatedAt: dt("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] }), uniqueIndex("uq_pg_post_seq").on(t.postId, t.seq)],
);

export const gateUnlocks = mysqlTable(
  "gate_unlocks",
  {
    gateId: int("gate_id", { unsigned: true }).notNull(),
    userId: int("user_id", { unsigned: true }).notNull(),
    pricePaid: int("price_paid", { unsigned: true }).notNull().default(0),
    authorIncome: int("author_income", { unsigned: true }).notNull().default(0),
    /** 读者支出分录；价格 0 与迁移记录为 NULL */
    ledgerId: bigint("ledger_id", { mode: "number", unsigned: true }),
    source: mysqlEnum("source", ["purchase", "migrated"]).notNull().default("purchase"),
    unlockedAt: dt("unlocked_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gateId, t.userId] }), index("idx_gu_user").on(t.userId)],
);

export const attachments = mysqlTable(
  "attachments",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    postId: int("post_id", { unsigned: true }).notNull(),
    uploaderId: int("uploader_id", { unsigned: true }).notNull(),
    originalName: varchar("original_name", { length: 255 }).notNull().default(""),
    /** 存储键：历史附件为相对 attachment/ 的旧路径，新上传为 upload/… */
    storageKey: varchar("storage_key", { length: 255 }).notNull(),
    mime: varchar("mime", { length: 100 }).notNull().default(""),
    sizeBytes: int("size_bytes", { unsigned: true }).notNull().default(0),
    width: smallint("width", { unsigned: true }),
    height: smallint("height", { unsigned: true }),
    downloads: int("downloads", { unsigned: true }).notNull().default(0),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_att_post").on(t.postId),
    index("idx_att_uploader").on(t.uploaderId),
  ],
);

export const tags = mysqlTable(
  "tags",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    name: varchar("name", { length: 64 }).notNull(),
    threadCount: int("thread_count", { unsigned: true }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.id] }), uniqueIndex("uq_tags_name").on(t.name)],
);

export const threadTags = mysqlTable(
  "thread_tags",
  {
    threadId: int("thread_id", { unsigned: true }).notNull(),
    tagId: int("tag_id", { unsigned: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.tagId] }), index("idx_tt_tag").on(t.tagId)],
);

// ============================================================
// 互动
// ============================================================

export const reactions = mysqlTable(
  "reactions",
  {
    userId: int("user_id", { unsigned: true }).notNull(),
    postId: int("post_id", { unsigned: true }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull().default("like"),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.postId, t.kind] }), index("idx_rx_post").on(t.postId)],
);

export const follows = mysqlTable(
  "follows",
  {
    userId: int("user_id", { unsigned: true }).notNull(),
    targetType: mysqlEnum("target_type", ["user", "forum"]).notNull(),
    targetId: int("target_id", { unsigned: true }).notNull(),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.targetType, t.targetId] }),
    index("idx_fl_target").on(t.targetType, t.targetId),
  ],
);

export const polls = mysqlTable(
  "polls",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    threadId: int("thread_id", { unsigned: true }).notNull(),
    /** 最多可选项数；1 = 单选 */
    optionLimit: smallint("option_limit", { unsigned: true }).notNull().default(1),
    endsAt: dt("ends_at"),
    resultVisibility: mysqlEnum("result_visibility", ["always", "after_vote"])
      .notNull()
      .default("always"),
    voterCount: int("voter_count", { unsigned: true }).notNull().default(0),
    createdBy: int("created_by", { unsigned: true }).notNull(),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] }), uniqueIndex("uq_polls_thread").on(t.threadId)],
);

export const pollOptions = mysqlTable(
  "poll_options",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    pollId: int("poll_id", { unsigned: true }).notNull(),
    content: varchar("content", { length: 255 }).notNull(),
    voteCount: int("vote_count", { unsigned: true }).notNull().default(0),
    sortOrder: smallint("sort_order").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.id] }), index("idx_po_poll").on(t.pollId, t.sortOrder)],
);

export const pollVotes = mysqlTable(
  "poll_votes",
  {
    pollId: int("poll_id", { unsigned: true }).notNull(),
    optionId: int("option_id", { unsigned: true }).notNull(),
    userId: int("user_id", { unsigned: true }).notNull(),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pollId, t.optionId, t.userId] }),
    index("idx_pv_user").on(t.userId),
  ],
);

/** 会话模型私信：单聊 pair_key = 「小uid:大uid」，保证同一对用户只有一个会话 */
export const conversations = mysqlTable(
  "conversations",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    kind: mysqlEnum("kind", ["direct"]).notNull().default("direct"),
    pairKey: varchar("pair_key", { length: 32 }).notNull(),
    lastMessageAt: dt("last_message_at"),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] }), uniqueIndex("uq_conv_pair").on(t.pairKey)],
);

export const conversationMembers = mysqlTable(
  "conversation_members",
  {
    conversationId: int("conversation_id", { unsigned: true }).notNull(),
    userId: int("user_id", { unsigned: true }).notNull(),
    lastReadMessageId: bigint("last_read_message_id", { mode: "number", unsigned: true }),
    deletedAt: dt("deleted_at"),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] }), index("idx_cm_user").on(t.userId)],
);

export const messages = mysqlTable(
  "messages",
  {
    id: bigint("id", { mode: "number", unsigned: true }).notNull().autoincrement(),
    conversationId: int("conversation_id", { unsigned: true }).notNull(),
    senderId: int("sender_id", { unsigned: true }).notNull(),
    body: text("body").notNull(),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] }), index("idx_msg_conv").on(t.conversationId, t.id)],
);

// ============================================================
// 积分与荣誉（docs/POINTS.md）
// ============================================================

export const pointAccounts = mysqlTable(
  "point_accounts",
  {
    userId: int("user_id", { unsigned: true }).notNull(),
    balance: int("balance", { unsigned: true }).notNull().default(0),
    lifetimeEarned: bigint("lifetime_earned", { mode: "number", unsigned: true })
      .notNull()
      .default(0),
    lifetimeSpent: bigint("lifetime_spent", { mode: "number", unsigned: true })
      .notNull()
      .default(0),
    updatedAt: dt("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId] })],
);

/** 台账：只增不改不删；idempotency_key 唯一保证重试/事件重放不重复发放 */
export const pointLedger = mysqlTable(
  "point_ledger",
  {
    id: bigint("id", { mode: "number", unsigned: true }).notNull().autoincrement(),
    userId: int("user_id", { unsigned: true }).notNull(),
    delta: int("delta").notNull(),
    balanceAfter: int("balance_after", { unsigned: true }).notNull(),
    /** 命名空间渠道键，如 earn.post / spend.gate_unlock / opening（须先注册） */
    channel: varchar("channel", { length: 48 }).notNull(),
    refType: varchar("ref_type", { length: 32 }),
    refId: bigint("ref_id", { mode: "number", unsigned: true }),
    idempotencyKey: varchar("idempotency_key", { length: 96 }).notNull(),
    note: varchar("note", { length: 255 }).notNull().default(""),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("uq_pl_idem").on(t.idempotencyKey),
    index("idx_pl_user").on(t.userId, t.id),
    index("idx_pl_channel").on(t.channel, t.createdAt),
  ],
);

export const checkins = mysqlTable(
  "checkins",
  {
    userId: int("user_id", { unsigned: true }).notNull(),
    checkinDate: date("checkin_date", { mode: "string" }).notNull(),
    reward: int("reward", { unsigned: true }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.checkinDate] })],
);

/** 荣誉徽章：纯展示、零权限语义（团队徽章 + 旧勋章） */
export const badges = mysqlTable(
  "badges",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    key: varchar("key", { length: 48 }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    description: varchar("description", { length: 255 }).notNull().default(""),
    icon: varchar("icon", { length: 100 }).notNull().default(""),
    kind: mysqlEnum("kind", ["team", "honor"]).notNull().default("honor"),
    sortOrder: smallint("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.id] }), uniqueIndex("uq_badges_key").on(t.key)],
);

export const userBadges = mysqlTable(
  "user_badges",
  {
    userId: int("user_id", { unsigned: true }).notNull(),
    badgeId: int("badge_id", { unsigned: true }).notNull(),
    awardedAt: dt("awarded_at").notNull(),
    awardedBy: int("awarded_by", { unsigned: true }),
    expiresAt: dt("expires_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.badgeId] }), index("idx_ub_badge").on(t.badgeId)],
);

// ============================================================
// 权限内核（docs/AUTHZ.md §8）
// ============================================================

export const roles = mysqlTable(
  "roles",
  {
    key: varchar("key", { length: 64 }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    kind: mysqlEnum("kind", ["builtin", "custom"]).notNull(),
    description: varchar("description", { length: 255 }).notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.key] })],
);

export const permissions = mysqlTable(
  "permissions",
  {
    key: varchar("key", { length: 64 }).notNull(),
    resource: varchar("resource", { length: 32 }).notNull(),
    // 分级域权限点带 read/write/manage（manage ⊃ write ⊃ read）；动作型为 NULL
    level: mysqlEnum("level", ["read", "write", "manage"]),
    description: varchar("description", { length: 255 }).notNull().default(""),
    legacyKey: varchar("legacy_key", { length: 64 }),
    conditionParams: json("condition_params"),
  },
  (t) => [primaryKey({ columns: [t.key] })],
);

/** 角色授权：scope_id = 0 全局，> 0 为版块 id（唯一键无 NULL，幂等可靠） */
export const roleGrants = mysqlTable(
  "role_grants",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    roleKey: varchar("role_key", { length: 64 }).notNull(),
    permissionKey: varchar("permission_key", { length: 64 }).notNull(),
    scopeId: int("scope_id", { unsigned: true }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("uq_rg_grant").on(t.roleKey, t.permissionKey, t.scopeId),
    index("idx_rg_perm_scope").on(t.permissionKey, t.scopeId),
  ],
);

export const userRoles = mysqlTable(
  "user_roles",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    userId: int("user_id", { unsigned: true }).notNull(),
    roleKey: varchar("role_key", { length: 64 }).notNull(),
    scopeId: int("scope_id", { unsigned: true }).notNull().default(0),
    expiresAt: dt("expires_at"),
    grantedBy: int("granted_by", { unsigned: true }),
    grantedAt: dt("granted_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("uq_ur_assignment").on(t.userId, t.roleKey, t.scopeId),
    index("idx_ur_user").on(t.userId),
  ],
);

// ============================================================
// 平台
// ============================================================

export const eventLog = mysqlTable(
  "event_log",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    eventName: varchar("event_name", { length: 64 }).notNull(),
    payload: json("payload"),
    actorId: int("actor_id", { unsigned: true }),
    source: varchar("source", { length: 64 }),
    errorJson: json("error_json"), // 消费异常摘要数组
    createdAt: dt("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_el_name_time").on(t.eventName, t.createdAt),
    index("idx_el_time").on(t.createdAt),
  ],
);

export const moduleState = mysqlTable(
  "module_state",
  {
    moduleId: varchar("module_id", { length: 64 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: dt("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.moduleId] })],
);

export const migrationState = mysqlTable(
  "migration_state",
  {
    entity: varchar("entity", { length: 64 }).notNull(),
    rowsWritten: bigint("rows_written", { mode: "number", unsigned: true }).notNull().default(0),
    durationMs: bigint("duration_ms", { mode: "number", unsigned: true }).notNull().default(0),
    finishedAt: dt("finished_at"),
    note: varchar("note", { length: 255 }).notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.entity] })],
);

/** 管理动作统一审计：谁/何时/做了什么/对谁/前后值 */
export const auditLog = mysqlTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number", unsigned: true }).notNull().autoincrement(),
    actorId: int("actor_id", { unsigned: true }),
    action: varchar("action", { length: 64 }).notNull(),
    targetType: varchar("target_type", { length: 32 }).notNull().default(""),
    targetId: varchar("target_id", { length: 64 }).notNull().default(""),
    beforeJson: json("before_json"),
    afterJson: json("after_json"),
    ip: varchar("ip", { length: 64 }),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_audit_actor").on(t.actorId, t.createdAt),
    index("idx_audit_target").on(t.targetType, t.targetId),
    index("idx_audit_time").on(t.createdAt),
  ],
);

// ============================================================
// 关系声明（查询辅助；不生成外键）
// ============================================================

export const threadsRelations = relations(threads, ({ one, many }) => ({
  forum: one(forums, { fields: [threads.forumId], references: [forums.id] }),
  author: one(users, { fields: [threads.authorId], references: [users.id] }),
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  thread: one(threads, { fields: [posts.threadId], references: [threads.id] }),
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  gates: many(postGates),
}));

export const postGatesRelations = relations(postGates, ({ one }) => ({
  post: one(posts, { fields: [postGates.postId], references: [posts.id] }),
}));
