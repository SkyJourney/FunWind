import { relations } from "drizzle-orm";
import {
  boolean,
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
 * qysub_next 单一事实源（决策 #10）
 * 语义基线：P0 期手写 DDL（migration/schema/schema.sql，保留为历史底稿）。
 * 约定：
 *  - 不建外键（导入/迁移友好，参照完整性由应用层保证）
 *  - 保留旧主键（uid/tid/pid/fid/aid/gid），每表 raw JSON 归档旧行
 *  - 时间为 DATETIME 北京时间墙面值；utf8mb4 / InnoDB（库级默认）
 * 注意：users.username 需要列级 COLLATE utf8mb4_0900_as_cs（さくら≠サクラ）。
 * 若 drizzle-kit 不支持列级 collate，由 scripts/bootstrap.ts 的 patch 步骤幂等补齐（见 PATCHES）。
 */

// ---------- 用户与权限 ----------

export const groups = mysqlTable(
  "groups",
  {
    id: int("id", { unsigned: true }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    type: mysqlEnum("type", ["default", "member", "system", "special", "vip"])
      .notNull()
      .default("member"),
    points: int("points", { unsigned: true }).notNull().default(0),
    image: varchar("image", { length: 64 }).notNull().default(""),
    raw: json("raw"),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const users = mysqlTable(
  "users",
  {
    id: int("id", { unsigned: true }).notNull(),
    username: varchar("username", { length: 64 }).notNull(),
    email: varchar("email", { length: 128 }).notNull().default(""),
    passwordHash: varchar("password_hash", { length: 255 }),
    groupId: int("group_id", { unsigned: true }).notNull().default(0),
    gender: tinyint("gender").notNull().default(0),
    location: varchar("location", { length: 100 }).notNull().default(""),
    homepage: varchar("homepage", { length: 200 }).notNull().default(""),
    signatureMd: text("signature_md"),
    profile: text("profile"),
    postCount: int("post_count", { unsigned: true }).notNull().default(0),
    digestCount: int("digest_count", { unsigned: true }).notNull().default(0),
    followers: int("followers", { unsigned: true }).notNull().default(0),
    fans: int("fans", { unsigned: true }).notNull().default(0),
    credits: json("credits"),
    onlineTime: int("online_time", { unsigned: true }).notNull().default(0),
    isSpam: boolean("is_spam").notNull().default(false),
    status: smallint("status").notNull().default(0),
    createdAt: datetime("created_at"),
    lastVisitAt: datetime("last_visit_at"),
    lastPostAt: datetime("last_post_at"),
    raw: json("raw"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("uq_users_username").on(t.username),
    index("idx_users_email").on(t.email),
    index("idx_users_group").on(t.groupId),
    index("idx_users_spam").on(t.isSpam),
    index("idx_users_created").on(t.createdAt),
  ],
);

export const forums = mysqlTable(
  "forums",
  {
    id: smallint("id", { unsigned: true }).notNull(),
    parentId: smallint("parent_id", { unsigned: true }).notNull().default(0),
    type: mysqlEnum("type", ["category", "forum", "sub", "sub2"]).notNull().default("forum"),
    name: varchar("name", { length: 255 }).notNull(),
    nameStyle: varchar("name_style", { length: 255 }).notNull().default(""),
    description: text("description"),
    summary: text("summary"),
    vieworder: smallint("vieworder").notNull().default(0),
    isShow: boolean("is_show").notNull().default(true),
    managers: json("managers"),
    icon: varchar("icon", { length: 100 }).notNull().default(""),
    logo: varchar("logo", { length: 100 }).notNull().default(""),
    threadCount: int("thread_count", { unsigned: true }).notNull().default(0),
    postCount: int("post_count", { unsigned: true }).notNull().default(0),
    raw: json("raw"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_forums_parent").on(t.parentId),
    index("idx_forums_order").on(t.vieworder),
  ],
);

export const threads = mysqlTable(
  "threads",
  {
    id: int("id", { unsigned: true }).notNull(),
    forumId: smallint("forum_id", { unsigned: true }).notNull().default(0),
    authorId: int("author_id", { unsigned: true }).notNull().default(0),
    title: varchar("title", { length: 140 }).notNull().default(""),
    typeId: int("type_id", { unsigned: true }).notNull().default(0),
    digest: tinyint("digest").notNull().default(0),
    topped: tinyint("topped").notNull().default(0),
    special: varchar("special", { length: 20 }).notNull().default(""),
    replyCount: int("reply_count", { unsigned: true }).notNull().default(0),
    viewCount: int("view_count", { unsigned: true }).notNull().default(0),
    likeCount: int("like_count", { unsigned: true }).notNull().default(0),
    attachCount: smallint("attach_count", { unsigned: true }).notNull().default(0),
    contentMd: mediumtext("content_md"),
    contentRaw: mediumtext("content_raw"),
    usehtml: boolean("usehtml").notNull().default(false),
    tags: varchar("tags", { length: 255 }).notNull().default(""),
    isSpam: boolean("is_spam").notNull().default(false),
    status: tinyint("status").notNull().default(0),
    createdAt: datetime("created_at"),
    lastPostAt: datetime("last_post_at"),
    lastPostUserId: int("last_post_user_id", { unsigned: true }).notNull().default(0),
    raw: json("raw"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_threads_forum").on(t.forumId, t.isSpam, t.lastPostAt),
    index("idx_threads_author").on(t.authorId),
    index("idx_threads_created").on(t.createdAt),
    index("idx_threads_digest").on(t.digest),
  ],
);

export const posts = mysqlTable(
  "posts",
  {
    id: int("id", { unsigned: true }).notNull(),
    threadId: int("thread_id", { unsigned: true }).notNull(),
    authorId: int("author_id", { unsigned: true }).notNull().default(0),
    floor: int("floor", { unsigned: true }).notNull().default(0),
    replyToPid: int("reply_to_pid", { unsigned: true }),
    subject: varchar("subject", { length: 100 }).notNull().default(""),
    contentMd: mediumtext("content_md"),
    contentRaw: mediumtext("content_raw"),
    usehtml: boolean("usehtml").notNull().default(false),
    likeCount: int("like_count", { unsigned: true }).notNull().default(0),
    status: tinyint("status").notNull().default(0),
    createdAt: datetime("created_at"),
    modifiedAt: datetime("modified_at"),
    raw: json("raw"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_posts_thread").on(t.threadId, t.floor),
    index("idx_posts_author").on(t.authorId),
    index("idx_posts_reply").on(t.replyToPid),
  ],
);

export const attachments = mysqlTable(
  "attachments",
  {
    id: int("id", { unsigned: true }).notNull(),
    threadId: int("thread_id", { unsigned: true }),
    postId: int("post_id", { unsigned: true }),
    uploaderId: int("uploader_id", { unsigned: true }).notNull().default(0),
    filename: varchar("filename", { length: 255 }).notNull().default(""),
    type: varchar("type", { length: 20 }).notNull().default(""),
    sizeKb: int("size_kb", { unsigned: true }).notNull().default(0),
    path: varchar("path", { length: 255 }).notNull().default(""),
    hasThumb: boolean("has_thumb").notNull().default(false),
    width: smallint("width", { unsigned: true }).notNull().default(0),
    height: smallint("height", { unsigned: true }).notNull().default(0),
    downloads: int("downloads", { unsigned: true }).notNull().default(0),
    cost: int("cost", { unsigned: true }).notNull().default(0),
    special: tinyint("special").notNull().default(0),
    createdAt: datetime("created_at"),
    raw: json("raw"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_att_thread").on(t.threadId),
    index("idx_att_post").on(t.postId),
    index("idx_att_uploader").on(t.uploaderId),
  ],
);

// ---------- 表情 ----------

export const emoticonCategories = mysqlTable(
  "emoticon_categories",
  {
    id: int("id", { unsigned: true }).notNull(),
    name: varchar("name", { length: 64 }).notNull().default(""),
    folder: varchar("folder", { length: 32 }).notNull().default(""),
    apps: varchar("apps", { length: 64 }).notNull().default(""),
    orderid: int("orderid", { unsigned: true }).notNull().default(0),
    isOpen: boolean("is_open").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const emoticons = mysqlTable(
  "emoticons",
  {
    id: int("id", { unsigned: true }).notNull(),
    categoryId: int("category_id", { unsigned: true }).notNull().default(0),
    folder: varchar("folder", { length: 32 }).notNull().default(""),
    icon: varchar("icon", { length: 64 }).notNull().default(""),
    isUsed: boolean("is_used").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.id] }), index("idx_emo_cat").on(t.categoryId)],
);

// ---------- 勋章 ----------

export const medals = mysqlTable(
  "medals",
  {
    id: int("id", { unsigned: true }).notNull(),
    name: varchar("name", { length: 64 }).notNull().default(""),
    path: varchar("path", { length: 64 }).notNull().default(""),
    image: varchar("image", { length: 64 }).notNull().default(""),
    icon: varchar("icon", { length: 64 }).notNull().default(""),
    description: varchar("description", { length: 255 }).notNull().default(""),
    medalType: tinyint("medal_type").notNull().default(1),
    receiveType: tinyint("receive_type").notNull().default(1),
    medalGids: varchar("medal_gids", { length: 64 }).notNull().default(""),
    awardType: tinyint("award_type").notNull().default(1),
    awardCondition: smallint("award_condition").notNull().default(0),
    expiredDays: smallint("expired_days").notNull().default(0),
    isOpen: boolean("is_open").notNull().default(true),
    vieworder: tinyint("vieworder").notNull().default(0),
    raw: json("raw"),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const userMedals = mysqlTable(
  "user_medals",
  {
    userId: int("user_id", { unsigned: true }).notNull(),
    medalId: int("medal_id", { unsigned: true }).notNull(),
    counts: int("counts", { unsigned: true }).notNull().default(0),
    expiredTime: datetime("expired_time"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.medalId] }), index("idx_um_medal").on(t.medalId)],
);

// ---------- 积分 ----------

export const creditLogs = mysqlTable(
  "credit_logs",
  {
    id: int("id", { unsigned: true }).notNull(),
    userId: int("user_id", { unsigned: true }).notNull().default(0),
    creditType: varchar("credit_type", { length: 8 }).notNull().default(""),
    delta: int("delta").notNull().default(0),
    logType: varchar("log_type", { length: 40 }).notNull().default(""),
    description: varchar("description", { length: 255 }).notNull().default(""),
    createdAt: datetime("created_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_cl_user").on(t.userId, t.creditType),
    index("idx_cl_time").on(t.createdAt),
  ],
);

// ---------- 投票 ----------

export const polls = mysqlTable(
  "polls",
  {
    id: int("id", { unsigned: true }).notNull(),
    threadId: int("thread_id", { unsigned: true }),
    voterNum: int("voter_num", { unsigned: true }).notNull().default(0),
    isafterView: boolean("isafter_view").notNull().default(false),
    isincludeImg: boolean("isinclude_img").notNull().default(false),
    optionLimit: smallint("option_limit", { unsigned: true }).notNull().default(0),
    expiredTime: datetime("expired_time"),
    creatorId: int("creator_id", { unsigned: true }).notNull().default(0),
    createdAt: datetime("created_at"),
    raw: json("raw"),
  },
  (t) => [primaryKey({ columns: [t.id] }), index("idx_polls_thread").on(t.threadId)],
);

export const pollOptions = mysqlTable(
  "poll_options",
  {
    id: int("id", { unsigned: true }).notNull(),
    pollId: int("poll_id", { unsigned: true }).notNull(),
    votedNum: int("voted_num", { unsigned: true }).notNull().default(0),
    content: varchar("content", { length: 255 }).notNull().default(""),
    image: varchar("image", { length: 255 }).notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.id] }), index("idx_po_poll").on(t.pollId)],
);

export const pollVoters = mysqlTable(
  "poll_voters",
  {
    pollId: int("poll_id", { unsigned: true }).notNull(),
    optionId: int("option_id", { unsigned: true }).notNull(),
    userId: int("user_id", { unsigned: true }).notNull(),
    createdAt: datetime("created_at"),
  },
  (t) => [
    primaryKey({ columns: [t.pollId, t.optionId, t.userId] }),
    index("idx_pv_user").on(t.userId),
  ],
);

// ---------- 私信 ----------

export const privateMessages = mysqlTable(
  "private_messages",
  {
    id: int("id", { unsigned: true }).notNull(),
    fromUid: int("from_uid", { unsigned: true }).notNull().default(0),
    toUid: int("to_uid", { unsigned: true }).notNull().default(0),
    content: mediumtext("content"),
    createdAt: datetime("created_at"),
    raw: json("raw"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idx_pm_from").on(t.fromUid),
    index("idx_pm_to").on(t.toUid),
  ],
);

export const messageDialogs = mysqlTable(
  "message_dialogs",
  {
    id: int("id", { unsigned: true }).notNull(),
    fromUid: int("from_uid", { unsigned: true }).notNull().default(0),
    toUid: int("to_uid", { unsigned: true }).notNull().default(0),
    unreadCount: smallint("unread_count", { unsigned: true }).notNull().default(0),
    messageCount: int("message_count", { unsigned: true }).notNull().default(0),
    lastMessage: text("last_message"),
    modifiedAt: datetime("modified_at"),
  },
  (t) => [primaryKey({ columns: [t.id] }), index("idx_md_to").on(t.toUid)],
);

// ---------- 基建 ----------

export const migrationState = mysqlTable(
  "migration_state",
  {
    entity: varchar("entity", { length: 64 }).notNull(),
    rowsWritten: int("rows_written", { unsigned: true }).notNull().default(0), // BIGINT 语义由应用层保证，行数上限内 int 足够
    durationMs: int("duration_ms", { unsigned: true }).notNull().default(0),
    finishedAt: datetime("finished_at"),
    note: varchar("note", { length: 255 }).notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.entity] })],
);

// ---------- 关系声明（查询辅助；不生成外键） ----------

export const threadsRelations = relations(threads, ({ one, many }) => ({
  forum: one(forums, { fields: [threads.forumId], references: [forums.id] }),
  author: one(users, { fields: [threads.authorId], references: [users.id] }),
  replies: many(posts),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  thread: one(threads, { fields: [posts.threadId], references: [threads.id] }),
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));
