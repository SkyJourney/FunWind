/**
 * 演示数据种子逻辑（可导入）：db:seed 脚本与 E2E 重置脚本共用。
 * ID 约定：90000+ 号段（旧库真实数据远低于此），幂等可重跑。
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  inviteCodes,
  siteSettings,
  userBans,
  userRoles,
  emoticonCategories,
  emoticons,
  forums,
  groups,
  medals,
  posts,
  threads,
  userMedals,
  users,
} from "./schema.js";

const ts = (s: string) => sql`${s}`;

async function seedGroups(db: Db) {
  await db
    .insert(groups)
    .values([
      { id: 1, name: "default", type: "default", points: 0, image: "1.gif" },
      { id: 8, name: "LV1.魔狱原住民", type: "member", points: 150, image: "1.gif" },
    ])
    .onDuplicateKeyUpdate({ set: { name: sql`VALUES(name)`, points: sql`VALUES(points)` } });
}

async function seedUsers(db: Db) {
  await db
    .insert(users)
    .values([
      {
        id: 90001,
        username: "demo_alice",
        email: "alice@demo.local",
        groupId: 8,
        postCount: 3,
        credits: { "1": 150 },
        signatureMd: "大家好，我是演示用户。",
        createdAt: ts("2026-01-01 10:00:00"),
        lastVisitAt: ts("2026-10-23 09:00:00"),
      },
      {
        id: 90002,
        username: "demo_小翼",
        email: "xiaoyi@demo.local",
        groupId: 1,
        postCount: 2,
        credits: { "1": 20 },
        createdAt: ts("2026-02-02 11:00:00"),
      },
    ])
    .onDuplicateKeyUpdate({
      set: { groupId: sql`VALUES(group_id)`, credits: sql`VALUES(credits)` },
    });
}

async function seedForums(db: Db) {
  await db
    .insert(forums)
    .values([
      { id: 900, parentId: 0, type: "category", name: "『演示区』", vieworder: 900 },
      {
        id: 901,
        parentId: 900,
        type: "forum",
        name: "『新·公告站』",
        description: "演示：站点公告与指南",
        vieworder: 1,
      },
      {
        id: 902,
        parentId: 900,
        type: "forum",
        name: "『怀旧茶话会』",
        description: "演示：聊旧站、聊字幕组往事",
        vieworder: 2,
      },
      {
        id: 903,
        parentId: 902,
        type: "sub",
        name: "『考古分舵』",
        description: "演示：2009-2013 老帖考古",
        vieworder: 1,
      },
    ])
    .onDuplicateKeyUpdate({
      set: { name: sql`VALUES(name)`, description: sql`VALUES(description)` },
    });
}

async function seedThreads(db: Db) {
  await db
    .insert(threads)
    .values([
      {
        id: 900001,
        forumId: 901,
        authorId: 90001,
        title: "欢迎来到新青翼：FunWind 上线指南",
        contentMd:
          "欢迎回来！\n\n这里保留了你熟悉的 **版块、楼层、勋章与青翼币**。\n\n- 老帖都能看：试试搜索「刀剣乱舞」\n- 表情回归：![表情](/emotion/01/17.gif)\n\n> 密码需要重置一次（旧密码不可迁移），邮件直达。",
        contentRaw: "欢迎回来！\n\n[b]这里保留了你熟悉的版块、楼层、勋章与青翼币。[/b]\n[s:146]",
        replyCount: 2,
        viewCount: 88,
        digest: 1,
        topped: 1,
        createdAt: ts("2026-10-01 09:00:00"),
        lastPostAt: ts("2026-10-20 21:00:00"),
        lastPostUserId: 90002,
      },
      {
        id: 900002,
        forumId: 902,
        authorId: 90002,
        title: "还记得 2010 年的第一部共做番吗",
        contentMd: "从《好想告诉你》聊起……欢迎在『考古分舵』翻旧帖。",
        contentRaw: "从《好想告诉你》聊起……",
        replyCount: 1,
        viewCount: 41,
        createdAt: ts("2026-10-05 14:30:00"),
        lastPostAt: ts("2026-10-06 08:10:00"),
        lastPostUserId: 90001,
      },
      {
        id: 900003,
        forumId: 902,
        authorId: 90001,
        title: "青翼币与等级体系回归说明",
        contentMd: "LV1.魔狱原住民 → LV12.圣魔王的进阶阈值原样保留。",
        contentRaw: "LV1.魔狱原住民 → LV12.圣魔王的进阶阈值原样保留。",
        replyCount: 0,
        viewCount: 12,
        createdAt: ts("2026-10-10 20:00:00"),
        lastPostAt: ts("2026-10-10 20:00:00"),
        lastPostUserId: 90001,
      },
    ])
    .onDuplicateKeyUpdate({
      set: {
        replyCount: sql`VALUES(reply_count)`,
        viewCount: sql`VALUES(view_count)`,
        lastPostAt: sql`VALUES(last_post_at)`,
      },
    });
}

async function seedPosts(db: Db) {
  await db
    .insert(posts)
    .values([
      {
        id: 900001,
        threadId: 900001,
        authorId: 90002,
        floor: 1,
        contentMd: "签到！密码重置流程很顺。",
        contentRaw: "签到！密码重置流程很顺。",
        createdAt: ts("2026-10-02 10:00:00"),
      },
      {
        id: 900002,
        threadId: 900001,
        authorId: 90001,
        floor: 2,
        replyToPid: 900001,
        contentMd: "重置有问题随时私信管理员。",
        contentRaw: "重置有问题随时私信管理员。",
        createdAt: ts("2026-10-02 12:00:00"),
      },
      {
        id: 900003,
        threadId: 900002,
        authorId: 90001,
        floor: 1,
        contentMd: "第一话的时间轴还历历在目。",
        contentRaw: "第一话的时间轴还历历在目。",
        createdAt: ts("2026-10-06 08:10:00"),
      },
    ])
    .onDuplicateKeyUpdate({ set: { contentMd: sql`VALUES(content_md)` } });
}

async function seedEmoticons(db: Db) {
  await db
    .insert(emoticonCategories)
    .values([
      { id: 117, name: "默认表情", folder: "01", orderid: 1, isOpen: true },
      { id: 118, name: "扩展表情", folder: "02", orderid: 2, isOpen: true },
    ])
    .onDuplicateKeyUpdate({ set: { name: sql`VALUES(name)` } });
  await db
    .insert(emoticons)
    .values([
      { id: 120, categoryId: 117, folder: "01", icon: "08.gif", isUsed: true },
      { id: 121, categoryId: 117, folder: "01", icon: "09.gif", isUsed: true },
      { id: 146, categoryId: 118, folder: "02", icon: "36.gif", isUsed: true },
    ])
    .onDuplicateKeyUpdate({ set: { folder: sql`VALUES(folder)`, icon: sql`VALUES(icon)` } });
}

async function seedMedals(db: Db) {
  await db
    .insert(medals)
    .values([
      {
        id: 901,
        name: "演示·开荒先锋",
        description: "新站首批入驻纪念",
        medalType: 1,
        isOpen: true,
      },
    ])
    .onDuplicateKeyUpdate({ set: { name: sql`VALUES(name)` } });
  await db
    .insert(userMedals)
    .values([{ userId: 90001, medalId: 901, counts: 1 }])
    .onDuplicateKeyUpdate({ set: { counts: sql`VALUES(counts)` } });
}

// ---------- 认证夹具（M4）----------

// 被封禁用户密码哈希（明文 e2e-banned-pass；预计算 argon2id——packages/db 不依赖 apps/web）
const BANNED_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$e3soyXfZ/wbsB+vxrPFUrA$l3IIWfhsuHFhCDMmVzXnS0TjiwWENRbboTfUwsM6YpY";

export async function seedAuthFixtures(db: Db): Promise<void> {
  // 注册模式：邀请制（站点默认语义）
  await db
    .insert(siteSettings)
    .values({ key: "register.mode", value: { mode: "invite" }, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: sql`VALUES(value)` } });

  // E2E 邀请码（永不过期、未使用；e2e-reset 每轮重置恢复）
  await db
    .insert(inviteCodes)
    .values({ code: "E2E-INVITE-CODE", batch: "e2e", createdAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { usedBy: null, usedAt: null } });

  // 被封禁演示用户（可登录：哈希如上；全局永久封禁 → 登录拦截用例）
  await db
    .insert(users)
    .values({
      id: 90003,
      username: "demo_banned",
      email: "banned@demo.local",
      groupId: 1,
      passwordHash: BANNED_HASH,
      credits: { "1": 0 },
    })
    .onDuplicateKeyUpdate({ set: { email: sql`VALUES(email)`, passwordHash: BANNED_HASH } });
  await db
    .insert(userBans)
    .values({ id: 901, userId: 90003, typeId: "1", fid: 0, reason: "E2E 封禁夹具" })
    .onDuplicateKeyUpdate({ set: { reason: sql`VALUES(reason)` } });
}

/**
 * 幂等写入全部演示数据（bootstrap 后调用）
 */
export async function seedDemoData(db: Db): Promise<void> {
  await seedGroups(db);
  await seedUsers(db);
  await seedForums(db);
  await seedThreads(db);
  await seedPosts(db);
  await seedEmoticons(db);
  await seedMedals(db);
  await seedAuthFixtures(db);
  await seedAdminFixtures(db);
}

// ---------- 权限夹具（M5）：管理员演示账户 ----------

export async function seedAdminFixtures(db: Db): Promise<void> {
  await db
    .insert(users)
    .values({
      id: 90004,
      username: "demo_admin",
      email: "admin@demo.local",
      groupId: 3,
      passwordHash:
        // 明文 e2e-admin-pass（预计算 argon2id）
        "$argon2id$v=19$m=19456,t=2,p=1$4ZRjLqgcJ4kA41dJfLLHUQ$lPZYIsJMv5I94ZOYGWcXvL+QNEKXcwx7Sz6bcAitpZU",
      credits: { "1": 0 },
    })
    .onDuplicateKeyUpdate({ set: { email: sql`VALUES(email)` } });
  await db
    .insert(userRoles)
    .values({ userId: 90004, roleKey: "admin", scopeType: "global", grantedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { grantedAt: sql`NOW()` } });
}
