/**
 * 演示数据种子逻辑（可导入）：db:seed 脚本与 E2E 重置脚本共用。
 * ID 约定：90000+ 号段（旧库真实数据远低于此），幂等可重跑。
 * v2 夹具覆盖 M5.5 的验收场景：受限版块、不出现在目录的版块、门控（积分/回复）、已购买记录、积分台账、封禁。
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  badges,
  forums,
  gateUnlocks,
  inviteCodes,
  pointAccounts,
  pointLedger,
  postGates,
  posts,
  roleGrants,
  siteSettings,
  threads,
  userBadges,
  userProfiles,
  userRestrictions,
  userRoles,
  users,
} from "./schema.js";
import { incoming } from "./sql.js";

// 预计算 argon2id（packages/db 不依赖 apps/web）。
// 明文 e2e-banned-pass
const BANNED_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$e3soyXfZ/wbsB+vxrPFUrA$l3IIWfhsuHFhCDMmVzXnS0TjiwWENRbboTfUwsM6YpY";
// 明文 e2e-admin-pass（admin / member / team 演示账户共用）
const ADMIN_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$4ZRjLqgcJ4kA41dJfLLHUQ$lPZYIsJMv5I94ZOYGWcXvL+QNEKXcwx7Sz6bcAitpZU";

/** 演示用户 id 常量（E2E 夹具引用） */
export const DEMO = {
  alice: 90001, // 无密码：老用户认领流程
  xiaoyi: 90002,
  banned: 90003,
  admin: 90004,
  member: 90005, // 已购买门控 9001
  team: 90006, // 字幕组成员：可读受限版块 904
  restrictedForum: 904,
  unlistedForum: 905,
  gatePost: 900104,
  pointsGate: 9001,
  replyGate: 9002,
} as const;

async function seedUsers(db: Db) {
  const row = (
    id: number,
    username: string,
    email: string,
    passwordHash: string | null,
    createdAt: string,
  ) => ({
    id,
    username,
    usernameKey: username.trim().toLowerCase(),
    email,
    emailKey: email.trim().toLowerCase(),
    passwordHash,
    createdAt,
  });
  await db
    .insert(users)
    .values([
      row(DEMO.alice, "demo_alice", "alice@demo.local", null, "2026-01-01 10:00:00"),
      row(DEMO.xiaoyi, "demo_小翼", "xiaoyi@demo.local", null, "2026-02-02 11:00:00"),
      row(DEMO.banned, "demo_banned", "banned@demo.local", BANNED_HASH, "2026-03-01 09:00:00"),
      row(DEMO.admin, "demo_admin", "admin@demo.local", ADMIN_HASH, "2026-03-02 09:00:00"),
      row(DEMO.member, "demo_member", "member@demo.local", ADMIN_HASH, "2026-03-03 09:00:00"),
      row(DEMO.team, "demo_team", "team@demo.local", ADMIN_HASH, "2026-03-04 09:00:00"),
    ])
    .onDuplicateKeyUpdate({
      set: { email: incoming("email"), passwordHash: incoming("password_hash") },
    });

  await db
    .insert(userProfiles)
    .values({ userId: DEMO.alice, signatureMd: "大家好，我是演示用户。", gender: 0 })
    .onDuplicateKeyUpdate({ set: { signatureMd: incoming("signature_md") } });
}

async function seedForums(db: Db) {
  await db
    .insert(forums)
    .values([
      {
        id: 900,
        parentId: 0,
        path: "/900/",
        depth: 1,
        kind: "section",
        name: "『演示区』",
        sortOrder: 900,
      },
      {
        id: 901,
        parentId: 900,
        path: "/900/901/",
        depth: 2,
        name: "『新·公告站』",
        description: "演示：站点公告与指南",
        sortOrder: 1,
      },
      {
        id: 902,
        parentId: 900,
        path: "/900/902/",
        depth: 2,
        name: "『怀旧茶话会』",
        description: "演示：聊旧站、聊字幕组往事",
        sortOrder: 2,
      },
      {
        id: 903,
        parentId: 902,
        path: "/900/902/903/",
        depth: 3,
        name: "『考古分舵』",
        description: "演示：2009-2013 老帖考古",
        sortOrder: 1,
      },
      {
        id: DEMO.restrictedForum,
        parentId: 900,
        path: "/900/904/",
        depth: 2,
        name: "『字幕组内部区』",
        description: "演示：仅字幕制作组可读（restricted）",
        sortOrder: 3,
        readPolicy: "restricted",
        writePolicy: "restricted",
      },
      {
        id: DEMO.unlistedForum,
        parentId: 900,
        path: "/900/905/",
        depth: 2,
        name: "『不上目录的版块』",
        description: "演示：is_listed=0，可直达但不进首页聚合",
        sortOrder: 4,
        isListed: false,
      },
    ])
    .onDuplicateKeyUpdate({
      set: {
        name: incoming("name"),
        description: incoming("description"),
        readPolicy: incoming("read_policy"),
        writePolicy: incoming("write_policy"),
        isListed: incoming("is_listed"),
      },
    });

  // 受限版块的读/写授权：仅字幕制作组（admin 在评估器中短路放行）
  await db
    .insert(roleGrants)
    .values(
      ["forum.read", "forum.write"].map((permissionKey) => ({
        roleKey: "team-subtitle",
        permissionKey,
        scopeId: DEMO.restrictedForum,
      })),
    )
    .onDuplicateKeyUpdate({ set: { roleKey: incoming("role_key") } });
}

interface DemoThread {
  id: number;
  forumId: number;
  authorId: number;
  title: string;
  firstPostId: number;
  firstBody: string;
  createdAt: string;
  topped?: number;
  digest?: number;
  hasGate?: boolean;
  viewCount?: number;
  replies: { id: number; authorId: number; body: string; at: string; replyTo?: number }[];
}

const DEMO_THREADS: DemoThread[] = [
  {
    id: 900001,
    forumId: 901,
    authorId: DEMO.alice,
    title: "欢迎来到新青翼：FunWind 上线指南",
    firstPostId: 900101,
    firstBody:
      "欢迎回来！\n\n这里保留了你熟悉的 **版块、楼层、勋章与积分**。\n\n- 老帖都能看：试试搜索「刀剣乱舞」\n- 表情直接用 Unicode：😀\n\n> 密码需要重置一次（旧密码不可迁移），邮件直达。",
    createdAt: "2026-10-01 09:00:00",
    topped: 1,
    digest: 1,
    viewCount: 88,
    replies: [
      {
        id: 900001,
        authorId: DEMO.xiaoyi,
        body: "签到！密码重置流程很顺。",
        at: "2026-10-02 10:00:00",
      },
      {
        id: 900002,
        authorId: DEMO.alice,
        body: "重置有问题随时私信管理员。",
        at: "2026-10-02 12:00:00",
        replyTo: 900001,
      },
    ],
  },
  {
    id: 900002,
    forumId: 902,
    authorId: DEMO.xiaoyi,
    title: "还记得 2010 年的第一部共做番吗",
    firstPostId: 900102,
    firstBody: "从《好想告诉你》聊起……欢迎在『考古分舵』翻旧帖。",
    createdAt: "2026-10-05 14:30:00",
    viewCount: 41,
    replies: [
      {
        id: 900003,
        authorId: DEMO.alice,
        body: "第一话的时间轴还历历在目。",
        at: "2026-10-06 08:10:00",
      },
    ],
  },
  {
    id: 900003,
    forumId: 902,
    authorId: DEMO.alice,
    title: "积分与荣誉体系说明",
    firstPostId: 900103,
    firstBody: "积分只通过发帖、回帖、签到获取；旧 LV 称号不再保留，团队身份以徽章展示。",
    createdAt: "2026-10-10 20:00:00",
    viewCount: 12,
    replies: [],
  },
  {
    // 门控夹具：积分门控（价格 10）+ 回复可见门控。body_md 只含占位，隐藏内容在 post_gates
    id: 900004,
    forumId: 901,
    authorId: DEMO.alice,
    title: "[门控演示] 付费与回复可见",
    firstPostId: DEMO.gatePost,
    firstBody:
      '公开部分：下面有两个门控。\n\n:::gate{id="9001"}\n:::\n\n中间还有公开文字。\n\n:::gate{id="9002"}\n:::\n\n结尾。',
    createdAt: "2026-10-12 09:00:00",
    hasGate: true,
    viewCount: 5,
    replies: [],
  },
  {
    // 受限版块夹具：游客/普通会员不得在任何位置看到其存在
    id: 900005,
    forumId: DEMO.restrictedForum,
    authorId: DEMO.team,
    title: "[内部] 本季度字幕分工表",
    firstPostId: 900105,
    firstBody: "仅字幕制作组可见：本季度分工如下……",
    createdAt: "2026-10-15 22:00:00",
    viewCount: 3,
    replies: [],
  },
  {
    // is_listed=0 版块夹具：可直达，但不得出现在首页最新动态
    id: 900006,
    forumId: DEMO.unlistedForum,
    authorId: DEMO.alice,
    title: "[不上目录] 隐藏版块里的帖子",
    firstPostId: 900106,
    firstBody: "这个版块不进首页目录与最新动态。",
    createdAt: "2026-10-16 10:00:00",
    viewCount: 1,
    replies: [],
  },
];

async function seedThreadsAndPosts(db: Db) {
  for (const t of DEMO_THREADS) {
    const last = t.replies.at(-1);
    await db
      .insert(threads)
      .values({
        id: t.id,
        forumId: t.forumId,
        authorId: t.authorId,
        title: t.title,
        firstPostId: t.firstPostId,
        topped: t.topped ?? 0,
        digest: t.digest ?? 0,
        replyCount: t.replies.length,
        viewCount: t.viewCount ?? 0,
        lastPostId: last?.id ?? t.firstPostId,
        lastPosterId: last?.authorId ?? t.authorId,
        lastPostedAt: last?.at ?? t.createdAt,
        createdAt: t.createdAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          replyCount: incoming("reply_count"),
          viewCount: incoming("view_count"),
          lastPostedAt: incoming("last_posted_at"),
        },
      });

    await db
      .insert(posts)
      .values({
        id: t.firstPostId,
        threadId: t.id,
        floor: 1,
        authorId: t.authorId,
        bodyMd: t.firstBody,
        hasGate: t.hasGate ?? false,
        createdAt: t.createdAt,
      })
      .onDuplicateKeyUpdate({ set: { bodyMd: incoming("body_md") } });

    for (const [i, r] of t.replies.entries()) {
      await db
        .insert(posts)
        .values({
          id: r.id,
          threadId: t.id,
          floor: i + 2,
          authorId: r.authorId,
          bodyMd: r.body,
          replyToPostId: r.replyTo ?? null,
          createdAt: r.at,
        })
        .onDuplicateKeyUpdate({ set: { bodyMd: incoming("body_md") } });
    }
  }
}

async function seedGates(db: Db) {
  await db
    .insert(postGates)
    .values([
      {
        id: DEMO.pointsGate,
        postId: DEMO.gatePost,
        seq: 1,
        conditions: [{ type: "points", price: 10 }],
        hiddenMd: "**付费内容**：这里是需要 10 积分才能解锁的隐藏正文。",
        createdAt: "2026-10-12 09:00:00",
        updatedAt: "2026-10-12 09:00:00",
      },
      {
        id: DEMO.replyGate,
        postId: DEMO.gatePost,
        seq: 2,
        conditions: [{ type: "reply" }],
        hiddenMd: "**回复可见**：回复本帖后才能看到这段内容。",
        createdAt: "2026-10-12 09:00:00",
        updatedAt: "2026-10-12 09:00:00",
      },
    ])
    .onDuplicateKeyUpdate({ set: { hiddenMd: incoming("hidden_md") } });

  // demo_member 已购买积分门控（迁移来源记录，不涉及台账）
  await db
    .insert(gateUnlocks)
    .values({
      gateId: DEMO.pointsGate,
      userId: DEMO.member,
      pricePaid: 10,
      authorIncome: 10,
      source: "migrated",
      unlockedAt: "2026-10-13 09:00:00",
    })
    .onDuplicateKeyUpdate({ set: { pricePaid: incoming("price_paid") } });
}

async function seedPoints(db: Db) {
  const balances: [number, number][] = [
    [DEMO.alice, 150],
    [DEMO.xiaoyi, 20],
    [DEMO.member, 100],
    [DEMO.team, 50],
  ];
  for (const [userId, balance] of balances) {
    await db
      .insert(pointAccounts)
      .values({ userId, balance, lifetimeEarned: balance, updatedAt: "2026-10-01 00:00:00" })
      .onDuplicateKeyUpdate({ set: { balance: incoming("balance") } });
    await db
      .insert(pointLedger)
      .values({
        userId,
        delta: balance,
        balanceAfter: balance,
        channel: "opening",
        idempotencyKey: `opening:${userId}`,
        note: "演示期初余额",
        createdAt: "2026-10-01 00:00:00",
      })
      .onDuplicateKeyUpdate({ set: { delta: incoming("delta") } });
  }
}

async function seedBadges(db: Db) {
  await db
    .insert(badges)
    .values({
      id: 901,
      key: "demo-pioneer",
      name: "演示·开荒先锋",
      description: "新站首批入驻纪念",
      kind: "honor",
    })
    .onDuplicateKeyUpdate({ set: { name: incoming("name") } });
  await db
    .insert(userBadges)
    .values({ userId: DEMO.alice, badgeId: 901, awardedAt: "2026-10-01 00:00:00" })
    .onDuplicateKeyUpdate({ set: { awardedAt: incoming("awarded_at") } });
}

// ---------- 认证与权限夹具 ----------

export async function seedAuthFixtures(db: Db): Promise<void> {
  // 注册模式：邀请制（站点默认语义；E2E 每轮重置）
  await db
    .insert(siteSettings)
    .values({ key: "register.mode", value: { mode: "invite" }, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: incoming("value") } });

  // E2E 邀请码（永不过期、未使用；e2e-reset 每轮重置恢复）
  await db
    .insert(inviteCodes)
    .values({ code: "E2E-INVITE-CODE", batch: "e2e", createdAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { usedBy: null, usedAt: null } });

  // 被封禁演示用户：全局永久封禁 → 登录拦截用例
  await db
    .insert(userRestrictions)
    .values({
      id: 901,
      userId: DEMO.banned,
      kind: "ban",
      scopeId: 0,
      reason: "E2E 封禁夹具",
      startsAt: "2026-03-05 00:00:00",
      createdAt: "2026-03-05 00:00:00",
    })
    .onDuplicateKeyUpdate({ set: { reason: incoming("reason") } });

  // 角色绑定：管理员 + 字幕组成员
  await db
    .insert(userRoles)
    .values([
      { userId: DEMO.admin, roleKey: "admin", scopeId: 0, grantedAt: "2026-03-02 09:00:00" },
      { userId: DEMO.team, roleKey: "team-subtitle", scopeId: 0, grantedAt: "2026-03-04 09:00:00" },
    ])
    .onDuplicateKeyUpdate({ set: { grantedAt: incoming("granted_at") } });
}

/**
 * 幂等写入全部演示数据（须在 bootstrapDb 之后调用：依赖内置角色与权限词汇表）
 */
export async function seedDemoData(db: Db): Promise<void> {
  await seedUsers(db);
  await seedForums(db);
  await seedThreadsAndPosts(db);
  await seedGates(db);
  await seedPoints(db);
  await seedBadges(db);
  await seedAuthFixtures(db);
}
