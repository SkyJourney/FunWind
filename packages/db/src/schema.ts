import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
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
 * qysub_next · schema v2.1（M5.5，单一事实源，决策 #10；设计依据 docs/DESIGN-MODEL.md；M7 增 event_outbox，共 45 表）
 *
 * 设计原则：
 *  - 运行时 schema 不认识旧站：不出现 legacy_* / 迁移标记 / 迁移用 id 公式 / migration_* 表（schema-rules.ts 强制）
 *  - 只保留 URL 必须稳定的 id（uid/fid/tid/pid）；主键均为 AUTO_INCREMENT，导入后把起点推到最大值之后
 *  - 引用诚实：每个 author_id 都指向 users 中真实存在的一行（已注销账号 = state=deleted 的占位行）
 *  - 唯一键不得依赖 NULL 去重来表达作用域/层级：全局作用域用 scope_id = 0 哨兵
 *    （例外：单列、且「空值 = 没有」本身就是期望语义，如 users.email_key）
 *  - 状态是一等属性（read_policy / state / user_restrictions），不靠「有没有记录」推断
 *  - 不建外键（导入友好，参照完整性由应用层保证）；时间为 DATETIME 北京墙面值；utf8mb4 / InnoDB
 *
 * 列级排序规则：username_key / email_key 需 utf8mb4_bin（さくら≠サクラ、归一化后精确比较）。
 * drizzle-kit 不支持列级 collate，由 bootstrap 的 PATCHES 幂等补齐（见 src/bootstrap.ts）。
 */

const dt = (name: string) => datetime(name, { mode: "string" });

/** 内容状态机（threads / posts 共用，见 docs/DESIGN-MODEL.md §4） */
export const CONTENT_STATES = ["visible", "pending", "rejected", "hidden", "deleted"] as const;
export type ContentState = (typeof CONTENT_STATES)[number];

/** 通知大类（公告不在其中：它走 announcements） */
export const NOTIFICATION_CATEGORIES = ["interaction", "message", "moderation", "account"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** 通知投递渠道；当前只实现 in_app，其余为注册边界预留 */
export const NOTIFICATION_CHANNELS = ["in_app", "email", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

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
    /** deleted = 已注销：保留行以维持引用完整，个人信息已清除 */
    state: mysqlEnum("state", ["active", "deleted"]).notNull().default("active"),
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
    /** 头像文件（files.id）；NULL = 无头像 */
    avatarFileId: int("avatar_file_id", { unsigned: true }),
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
    featuredCount: int("featured_count", { unsigned: true }).notNull().default(0),
    followerCount: int("follower_count", { unsigned: true }).notNull().default(0),
    lastPostAt: dt("last_post_at"),
  },
  (t) => [primaryKey({ columns: [t.userId] })],
);

/** 用户限制：封禁/禁言/禁头像/禁签名统一一处 */
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
     * 典型用途：仅团队成员可发帖的版块、只读公告版。
     */
    writePolicy: mysqlEnum("write_policy", ["inherit", "members", "restricted"])
      .notNull()
      .default("inherit"),
    /**
     * 审核策略：inherit 取最近的非 inherit 祖先（全无则 none）；
     * threads = 新主题需审核；all = 所有发帖（含回帖）需审核；持有 forum.moderate 的人免审。
     */
    reviewPolicy: mysqlEnum("review_policy", ["inherit", "none", "threads", "all"])
      .notNull()
      .default("inherit"),
    /** 是否出现在首页目录/最新动态（不上目录的版块仍可直达，不影响权限判定） */
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

/** 版块主题前缀 */
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
    title: varchar("title", { length: 255 }).notNull(),
    prefixId: int("prefix_id", { unsigned: true }),
    kind: mysqlEnum("kind", ["normal", "poll"]).notNull().default("normal"),
    firstPostId: int("first_post_id", { unsigned: true }),
    /** 状态机见 docs/DESIGN-MODEL.md §4：pending/rejected 仅作者与版主可见 */
    state: mysqlEnum("state", CONTENT_STATES).notNull().default("visible"),
    /** 置顶级别：0 无 / 1 版块 / 2 分区 / 3 全站 */
    pinLevel: tinyint("pin_level", { unsigned: true }).notNull().default(0),
    isFeatured: boolean("is_featured").notNull().default(false),
    isLocked: boolean("is_locked").notNull().default(false),
    /** 以下为可由 posts 重算的缓存 */
    replyCount: int("reply_count", { unsigned: true }).notNull().default(0),
    viewCount: int("view_count", { unsigned: true }).notNull().default(0),
    lastPostId: int("last_post_id", { unsigned: true }),
    lastPosterId: int("last_poster_id", { unsigned: true }),
    lastPostedAt: dt("last_posted_at"),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_threads_forum").on(t.forumId, t.state, t.pinLevel, t.lastPostedAt),
    // (author_id, created_at)：每日发主题配额与"最近一次发帖时间"都按作者 + 时间范围查（M6.1）；是旧单列索引的超集
    index("idx_threads_author_created").on(t.authorId, t.createdAt),
    index("idx_threads_created").on(t.createdAt),
    index("idx_threads_featured").on(t.isFeatured),
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
    /** 仅公开部分；门控隐藏内容拆在 post_gates.hidden_md（见 docs/GATES.md） */
    bodyMd: mediumtext("body_md"),
    replyToPostId: int("reply_to_post_id", { unsigned: true }),
    hasGate: boolean("has_gate").notNull().default(false),
    state: mysqlEnum("state", CONTENT_STATES).notNull().default("visible"),
    likeCount: int("like_count", { unsigned: true }).notNull().default(0),
    createdAt: dt("created_at").notNull(),
    editedAt: dt("edited_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("uq_posts_thread_floor").on(t.threadId, t.floor),
    index("idx_posts_author_created").on(t.authorId, t.createdAt),
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
    /** 帖内稳定身份（正文占位 :::gate{key="a1"} 引用它）；编辑时不变，解锁记录因此不丢 */
    gateKey: varchar("gate_key", { length: 16 }).notNull(),
    conditions: json("conditions").notNull(),
    matchMode: mysqlEnum("match_mode", ["all", "any"]).notNull().default("all"),
    hiddenMd: mediumtext("hidden_md").notNull(),
    unlockCount: int("unlock_count", { unsigned: true }).notNull().default(0),
    createdAt: dt("created_at").notNull(),
    updatedAt: dt("updated_at").notNull(),
    /** 隐藏正文最后一次变化的时间（M6.5）；NULL = 从未变化。改价、改条件不更新它 */
    contentUpdatedAt: dt("content_updated_at"),
  },
  (t) => [primaryKey({ columns: [t.id] }), uniqueIndex("uq_pg_post_key").on(t.postId, t.gateKey)],
);

export const gateUnlocks = mysqlTable(
  "gate_unlocks",
  {
    gateId: int("gate_id", { unsigned: true }).notNull(),
    userId: int("user_id", { unsigned: true }).notNull(),
    pricePaid: int("price_paid", { unsigned: true }).notNull().default(0),
    authorIncome: int("author_income", { unsigned: true }).notNull().default(0),
    /** 读者支出分录；价格 0 时为 NULL */
    ledgerId: bigint("ledger_id", { mode: "number", unsigned: true }),
    unlockedAt: dt("unlocked_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gateId, t.userId] }), index("idx_gu_user").on(t.userId)],
);

/**
 * 文件注册表：内容寻址（SHA-256）。附件、头像、正文图片、徽章图统一入库，
 * 存储位置由哈希派生（ab/cd/<sha256>.<ext>），根目录由 STORAGE_DIR 配置，可平移到对象存储。
 */
export const files = mysqlTable(
  "files",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    sha256: char("sha256", { length: 64 }).notNull(),
    storageKey: varchar("storage_key", { length: 128 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number", unsigned: true }).notNull().default(0),
    mime: varchar("mime", { length: 100 }).notNull().default(""),
    width: smallint("width", { unsigned: true }),
    height: smallint("height", { unsigned: true }),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("uq_files_sha256").on(t.sha256),
    uniqueIndex("uq_files_storage_key").on(t.storageKey),
  ],
);

/**
 * 帖子的下载附件（正文内联图片不进此表，只引用 files；门控块内的内联图例外，见 docs/ATTACHMENT-GATES.md Q5）。
 * gate_id：归属的门控（post_gates.id），NULL = 公开；一个附件至多属于一个门控。
 * 非空时访问权与该门控的隐藏正文同权（docs/ATTACHMENT-GATES.md）；指向不存在门控一律按锁定处理（fail-closed）。
 */
export const attachments = mysqlTable(
  "attachments",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    postId: int("post_id", { unsigned: true }).notNull(),
    gateId: int("gate_id", { unsigned: true }),
    fileId: int("file_id", { unsigned: true }).notNull(),
    uploaderId: int("uploader_id", { unsigned: true }).notNull(),
    originalName: varchar("original_name", { length: 255 }).notNull().default(""),
    downloads: int("downloads", { unsigned: true }).notNull().default(0),
    /** download = 帖末附件列表；inline = 正文内联引用的图片（保存时由服务端登记，M6.4） */
    kind: mysqlEnum("kind", ["download", "inline"]).notNull().default("download"),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_att_post").on(t.postId),
    index("idx_att_gate").on(t.gateId),
    index("idx_att_file").on(t.fileId),
    index("idx_att_uploader").on(t.uploaderId),
  ],
);

/**
 * 上传记录（M6.4）：每次成功上传一行，哪怕字节与已有文件去重命中。只用于配额计数与「谁上传过这个文件」的归属判定。
 * 不挂帖子：去重文件可被多帖引用，挂帖子会失真。
 */
export const fileUploads = mysqlTable(
  "file_uploads",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    userId: int("user_id", { unsigned: true }).notNull(),
    fileId: int("file_id", { unsigned: true }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number", unsigned: true }).notNull().default(0),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_uploads_user_created").on(t.userId, t.createdAt),
    index("idx_uploads_file").on(t.fileId),
  ],
);

/** 审核历史：每次通过/驳回留一行（当前状态以 posts.state 为准） */
export const contentReviews = mysqlTable(
  "content_reviews",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    postId: int("post_id", { unsigned: true }).notNull(),
    reviewerId: int("reviewer_id", { unsigned: true }).notNull(),
    decision: mysqlEnum("decision", ["approved", "rejected"]).notNull(),
    note: varchar("note", { length: 255 }).notNull().default(""),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] }), index("idx_cr_post").on(t.postId, t.id)],
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
// 通知中心（docs/NOTIFICATIONS.md）
// ============================================================

/** 逐人收件箱：互动 / 私信指针 / 审核与管理 / 账号与安全；公告不逐人写行，见 announcements */
export const notifications = mysqlTable(
  "notifications",
  {
    id: bigint("id", { mode: "number", unsigned: true }).notNull().autoincrement(),
    userId: int("user_id", { unsigned: true }).notNull(),
    category: mysqlEnum("category", NOTIFICATION_CATEGORIES).notNull(),
    /** 命名空间类型键，如 post.replied；由 notificationTypes 注册边界声明 */
    type: varchar("type", { length: 48 }).notNull(),
    /** 触发者；系统触发为 NULL */
    actorId: int("actor_id", { unsigned: true }),
    /** 指向对象类型（thread/post/user/conversation/forum/gate…）；无目标为空串 */
    targetType: varchar("target_type", { length: 32 }).notNull().default(""),
    targetId: bigint("target_id", { mode: "number", unsigned: true }).notNull().default(0),
    /** 聚合键：同键的未读通知合并为一条；NULL = 不聚合 */
    groupKey: varchar("group_key", { length: 96 }),
    /** JSON 快照（标题摘录、积分数、理由、聚合计数与最近触发者），避免对象被删后通知变空 */
    data: json("data"),
    readAt: dt("read_at"),
    createdAt: dt("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_nf_user_read").on(t.userId, t.readAt, t.id),
    index("idx_nf_user_category").on(t.userId, t.category, t.id),
    index("idx_nf_user_group").on(t.userId, t.groupKey, t.readAt),
  ],
);

/** 通知偏好：无记录 = 取注册边界里的默认值；强制类型（审核/限制/安全）不可关闭 */
export const notificationPreferences = mysqlTable(
  "notification_preferences",
  {
    userId: int("user_id", { unsigned: true }).notNull(),
    type: varchar("type", { length: 48 }).notNull(),
    channel: mysqlEnum("channel", NOTIFICATION_CHANNELS).notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.type, t.channel] })],
);

/** 站点公告（广播）：读取时与 notifications 合并，不逐人写行 */
export const announcements = mysqlTable(
  "announcements",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    title: varchar("title", { length: 200 }).notNull(),
    bodyMd: text("body_md").notNull(),
    level: mysqlEnum("level", ["info", "important"]).notNull().default("info"),
    audience: mysqlEnum("audience", ["all", "members"]).notNull().default("all"),
    showBanner: boolean("show_banner").notNull().default(false),
    startsAt: dt("starts_at").notNull(),
    /** NULL = 长期有效 */
    endsAt: dt("ends_at"),
    createdBy: int("created_by", { unsigned: true }).notNull(),
    createdAt: dt("created_at").notNull(),
    updatedAt: dt("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] }), index("idx_ann_window").on(t.startsAt, t.endsAt)],
);

export const announcementReads = mysqlTable(
  "announcement_reads",
  {
    userId: int("user_id", { unsigned: true }).notNull(),
    announcementId: int("announcement_id", { unsigned: true }).notNull(),
    readAt: dt("read_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.announcementId] }),
    index("idx_ar_announcement").on(t.announcementId),
  ],
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
    // M7 日上限聚合：按 (用户, 渠道, 北京自然日) 求当日已发放额
    index("idx_pl_user_channel_time").on(t.userId, t.channel, t.createdAt),
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

/** 荣誉徽章：纯展示、零权限语义（团队徽章 + 荣誉徽章） */
export const badges = mysqlTable(
  "badges",
  {
    id: int("id", { unsigned: true }).notNull().autoincrement(),
    key: varchar("key", { length: 48 }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    description: varchar("description", { length: 255 }).notNull().default(""),
    iconFileId: int("icon_file_id", { unsigned: true }),
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

/**
 * 事务性 outbox（M7，拍板记录见 docs/milestones/M7-gamification.md）：业务事务内 enqueue，
 * 提交后同步派发为快路径；崩溃留下的 pending 行由 drain 补派（SKIP LOCKED 防并发争抢）。
 * at-least-once 投递 + 消费端幂等（台账幂等键 / checkins / user_badges 联合主键）= 不重不丢。
 * dispatched_at 非空即已派发；重放经事件总线照常写 event_log（source="outbox" 区分）。
 */
export const eventOutbox = mysqlTable(
  "event_outbox",
  {
    id: bigint("id", { mode: "number", unsigned: true }).notNull().autoincrement(),
    eventName: varchar("event_name", { length: 64 }).notNull(),
    payload: json("payload"),
    actorId: int("actor_id", { unsigned: true }),
    source: varchar("source", { length: 64 }),
    createdAt: dt("created_at").notNull(),
    dispatchedAt: dt("dispatched_at"),
    dispatchError: json("dispatch_error"), // 最近一次补派失败的摘要
  },
  (t) => [primaryKey({ columns: [t.id] }), index("idx_eo_pending").on(t.dispatchedAt, t.id)],
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
