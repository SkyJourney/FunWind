/**
 * B2 迁移步骤：内容（统一 post / 门控 / 附件 / 标签）、表情资源、积分、徽章、社交、计数重算。
 * 每步 = extract → transform（纯函数）→ load（自然键幂等）。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { bumpAutoIncrement, load, newQuery, oldQuery, upsert } from "./db.js";
import {
  extractAttachments,
  extractAttention,
  extractBank,
  extractBuys,
  extractCreditBalances,
  extractDialogs,
  extractEmojiIds,
  extractForumJoins,
  extractLikes,
  extractMedalInfo,
  extractMedalUsers,
  extractMessages,
  extractPollOptions,
  extractPolls,
  extractPollVotes,
  extractPosts,
  extractPunchLogs,
  extractSpamTids,
  extractTagRelations,
  extractTags,
  extractThreads,
} from "./extract.js";
import { confinedPath, fileUrl } from "./lib/files.js";
import { head, idSet, loadUserIds, mapRows, type Step } from "./step-types.js";
import { transformBadges } from "./transform/badges.js";
import {
  noteAuthor,
  transformAttachments,
  transformContent,
  transformTags,
  transformUnlocks,
} from "./transform/content.js";
import { plainConverter } from "./transform/plain.js";
import { transformCheckins, transformPoints } from "./transform/points.js";
import { transformPlaceholders } from "./transform/users.js";
import {
  transformConversations,
  transformFollows,
  transformPolls,
  transformReactions,
} from "./transform/social.js";

const b = (v: boolean) => (v ? 1 : 0);
const jsonOf = (v: unknown) => JSON.stringify(v);

// ---------- 表情静态资源 ----------

export const emojiStep: Step = {
  name: "emoji",
  async run(ctx) {
    const rows = await oldQuery<{ id: number; folder: string; icon: string }>(
      `SELECT emotion_id AS id, emotion_folder AS folder, emotion_icon AS icon FROM nw_common_emotion`,
    );
    mkdirSync(config.emojiOutDir, { recursive: true });
    let copied = 0;
    let same = 0;
    const missing: string[] = [];
    let bytes = 0;
    for (const r of rows.sort((x, y) => Number(x.id) - Number(y.id))) {
      // 表情的 folder/icon 来自旧库配置表，同样按不可信输入处理：必须落在表情目录之内
      const src = confinedPath(config.emotionDir, join(r.folder, r.icon));
      if (!src) {
        missing.push(`${r.id}(路径越界，已拒绝)`);
        continue;
      }
      const dest = join(config.emojiOutDir, `${r.id}.gif`);
      if (!existsSync(src)) {
        missing.push(`${r.id}(${r.folder}/${r.icon})`);
        continue;
      }
      const size = statSync(src).size;
      bytes += size;
      if (existsSync(dest) && statSync(dest).size === size) {
        same++;
        continue;
      }
      copyFileSync(src, dest);
      copied++;
    }
    ctx.report
      .section("表情静态资源")
      .line(
        `旧站 ${rows.length} 枚表情复制到 apps/web/public/emoji/{emotion_id}.gif：新复制 ${copied}、已存在 ${same}、源文件缺失 ${missing.length}；合计 ${(bytes / 1024).toFixed(0)}KB。` +
          `运行时没有表情表；映射外的遗留表情码（旧站自己也渲染不出）已在正文中删除。`,
      )
      .bullets(missing.length ? [`缺失：${missing.join("、")}`] : []);
    if (missing.length) throw new Error(`表情源文件缺失: ${missing.join(", ")}`);
    return { rows: rows.length, note: `${copied} 新复制 / ${same} 已存在` };
  },
};

// ---------- 内容：统一 post / 门控 / 附件 / 标签 ----------

export const contentStep: Step = {
  name: "content",
  async run(ctx) {
    const [oldThreads, oldPosts, spamTids, emojiIds, oldAtts, buys] = [
      await extractThreads(),
      await extractPosts(),
      await extractSpamTids(),
      await extractEmojiIds(),
      await extractAttachments(),
      await extractBuys(),
    ];
    // 真实用户 = state=active；内容作者不在其中的才建「已注销用户」占位账号
    const userIds = await loadUserIds(ctx);
    const [forumIds, prefixIds] = [
      await idSet("SELECT id FROM forums"),
      await idSet("SELECT id FROM forum_prefixes"),
    ];
    const attMap = new Map(oldAtts.map((a) => [Number(a.aid), { name: a.name, path: a.path }]));

    const content = transformContent(oldThreads, oldPosts, {
      userIds,
      forumIds,
      prefixIds,
      spamTids,
      emojiIds,
      resolveUpload: (rel) => {
        const f = ctx.files.addUnder(config.attachmentDir, rel);
        return f ? fileUrl(f.storageKey) : null;
      },
      resolveAttachment: (aid) => {
        const a = attMap.get(aid);
        if (!a) return null;
        const f = ctx.files.addUnder(config.attachmentDir, a.path);
        return f
          ? { name: a.name, url: fileUrl(f.storageKey), image: f.mime.startsWith("image/") }
          : null;
      },
      asOf: ctx.asOf,
    });
    const postIds = new Set(content.posts.map((p) => p.id));
    const authorOf = new Map(content.posts.map((p) => [p.id, p.authorId]));
    const unlocks = transformUnlocks(
      buys,
      content.gates,
      postIds,
      content.firstPostOf,
      userIds,
      ctx.asOf,
    );
    const atts = transformAttachments(oldAtts, postIds, content.firstPostOf, authorOf, ctx.asOf);
    const tags = transformTags(
      await extractTags(),
      await extractTagRelations(),
      new Set(content.threads.map((t) => t.id)),
    );

    // 附件：先解析到文件；本体缺失的附件没有意义，丢弃并记入报告。写表由 files 步骤完成（需要 file_id）
    const missingAtts: string[] = [];
    ctx.attachments = [];
    for (const d of atts.rows) {
      const f = ctx.files.addUnder(config.attachmentDir, d.sourcePath);
      if (!f) {
        missingAtts.push(d.sourcePath);
        continue;
      }
      noteAuthor(content.placeholders, userIds, d.uploaderId, d.createdAt);
      ctx.attachments.push({
        postId: d.postId,
        uploaderId: d.uploaderId,
        originalName: d.originalName,
        downloads: d.downloads,
        createdAt: d.createdAt,
        sha256: f.sha256,
      });
    }

    // 占位账号：先清掉上一轮遗留的（只有占位账号是 state=deleted），再按本轮需要重建
    await newQuery(
      "DELETE FROM user_profiles WHERE user_id IN (SELECT id FROM users WHERE state = 'deleted')",
    );
    await newQuery(
      "DELETE FROM user_stats WHERE user_id IN (SELECT id FROM users WHERE state = 'deleted')",
    );
    await newQuery("DELETE FROM users WHERE state = 'deleted'");
    const ph = transformPlaceholders(content.placeholders);
    await upsert(
      "users",
      [
        "id",
        "username",
        "username_key",
        "email",
        "email_key",
        "password_hash",
        "email_verified_at",
        "state",
        "created_at",
        "last_login_at",
      ],
      ph.users.map((u) => ({
        id: u.id,
        username: u.username,
        username_key: u.usernameKey,
        email: u.email,
        email_key: u.emailKey,
        password_hash: u.passwordHash,
        email_verified_at: u.emailVerifiedAt,
        state: u.state,
        created_at: u.createdAt,
        last_login_at: u.lastLoginAt,
      })),
      ["id"],
    );
    await upsert(
      "user_profiles",
      ["user_id", "bio", "location", "website", "gender", "birthday", "signature_md"],
      ph.profiles.map((p) => ({
        user_id: p.userId,
        bio: p.bio,
        location: p.location,
        website: p.website,
        gender: p.gender,
        birthday: p.birthday,
        signature_md: p.signatureMd,
      })),
      ["user_id"],
    );
    await bumpAutoIncrement("users");

    await load(
      "threads",
      [
        "id",
        "forum_id",
        "author_id",
        "title",
        "prefix_id",
        "kind",
        "first_post_id",
        "pin_level",
        "is_featured",
        "view_count",
        "created_at",
      ],
      content.threads.map((t) => ({
        id: t.id,
        forum_id: t.forumId,
        author_id: t.authorId,
        title: t.title,
        prefix_id: t.prefixId,
        kind: t.kind,
        first_post_id: t.firstPostId,
        pin_level: t.pinLevel,
        is_featured: b(t.isFeatured),
        view_count: t.viewCount,
        created_at: t.createdAt,
      })),
      ["id"],
    );
    await load(
      "posts",
      [
        "id",
        "thread_id",
        "floor",
        "author_id",
        "body_md",
        "reply_to_post_id",
        "has_gate",
        "created_at",
        "edited_at",
      ],
      content.posts.map((p) => ({
        id: p.id,
        thread_id: p.threadId,
        floor: p.floor,
        author_id: p.authorId,
        body_md: p.bodyMd,
        reply_to_post_id: p.replyToPostId,
        has_gate: b(p.hasGate),
        created_at: p.createdAt,
        edited_at: p.editedAt,
      })),
      ["id"],
    );
    await load(
      "post_gates",
      [
        "id",
        "post_id",
        "gate_key",
        "conditions",
        "match_mode",
        "hidden_md",
        "created_at",
        "updated_at",
      ],
      content.gates.map((g) => ({
        id: g.id,
        post_id: g.postId,
        gate_key: g.gateKey,
        conditions: jsonOf(g.conditions),
        match_mode: g.matchMode,
        hidden_md: g.hiddenMd,
        created_at: g.createdAt,
        updated_at: g.updatedAt,
      })),
      ["id"],
    );
    await load(
      "gate_unlocks",
      ["gate_id", "user_id", "price_paid", "author_income", "unlocked_at"],
      unlocks.rows.map((u) => ({
        gate_id: u.gateId,
        user_id: u.userId,
        price_paid: u.pricePaid,
        author_income: u.authorIncome,
        unlocked_at: u.unlockedAt,
      })),
      ["gate_id", "user_id"],
    );
    await newQuery(
      `UPDATE post_gates g SET unlock_count =
         (SELECT COUNT(*) FROM gate_unlocks u WHERE u.gate_id = g.id)`,
    );
    await load(
      "tags",
      ["id", "name"],
      tags.tags.map((t) => ({ id: t.id, name: t.name })),
      ["id"],
    );
    await load(
      "thread_tags",
      ["thread_id", "tag_id"],
      tags.threadTags.map((t) => ({ thread_id: t.threadId, tag_id: t.tagId })),
      ["thread_id", "tag_id"],
    );
    for (const t of ["threads", "posts", "post_gates", "tags"]) {
      await bumpAutoIncrement(t);
    }

    const st = content.stats;
    const dropped = st.threadsDropped;
    const firstPosts = content.threads.length;
    const s = ctx.report.section("内容（统一 post 模型）");
    s.line(
      `只迁移**可见**内容：主题 ${content.threads.length}；帖子 ${content.posts.length} = 首帖 ${firstPosts} + 回帖 ${
        content.posts.length - firstPosts
      }。回收站、被屏蔽、垃圾空壳的内容一律不迁（旧库即归档）。` +
        `回帖保留旧 pid（锚点 #p{pid} 已冻结）；首帖旧站没有 pid，id 接在旧站全部帖子最大 pid 之后按 tid 升序自增；楼层按时间连续编号。`,
    );
    s.table(
      ["未迁移的主题", "数量"],
      [
        ["回收站（disabled）", dropped.deleted],
        ["被屏蔽（ifshield）", dropped.hidden],
        ["垃圾空壳（无正文无回复）", dropped.spamShell],
        ["版块已被删除或属回收站子树", dropped.badForum.length],
        ["无作者（uid 0）", dropped.noAuthor],
      ],
    );
    s.table(
      ["未迁移的回帖", "数量"],
      [
        ["所属主题未迁移", st.postsDropped.orphan],
        ["回收站（disabled）", st.postsDropped.deleted],
        ["被屏蔽（ifshield）", st.postsDropped.hidden],
        ["无作者（uid 0）", st.postsDropped.noAuthor],
      ],
    );
    s.bullets([
      `版块已被删除、仍是可见状态的主题（tid）：${head(dropped.badForum) || "无"}`,
      `无正文但有回复的主题，补了空首帖：${head(st.emptyFirstPosts) || "无"}`,
      `回复指针置空：跨主题 ${st.replyPointers.crossThread}；指向不存在的帖 ${st.replyPointers.dangling}；指向未迁移的帖 ${st.replyPointers.droppedTarget}`,
      `置顶级别（topped）与精华（digest）已映射为 pin_level / is_featured`,
      `「已注销用户」占位账号 ${ph.users.length} 个（保留原 uid，state=deleted，无邮箱无密码；只为内容作者与附件上传者建立，不持有积分、不能登录）`,
    ]);
    s.line("### 门控");
    s.bullets([
      `门控共 ${content.gates.length} 个：积分 ${st.gates.points} / 回复可见 ${st.gates.reply}；含门控的帖子 ${content.posts.filter((p) => p.hasGate).length}；帖内 key 为 g1、g2…`,
      `购买记录 ${buys.length} → 解锁记录 ${unlocks.rows.length}（旧购买按帖子计，一帖多门控时展开）`,
      `未生成解锁记录的购买：目标帖只有「回复可见」门控 ${unlocks.stats.replyOnly}（旧站把回复解锁也记入购买表，新模型按实际回帖实时判定）、` +
        `目标帖已无任何门控 ${unlocks.stats.noGate}、购买者不是真实用户 ${unlocks.stats.orphanBuyer}、目标帖未迁移 ${unlocks.stats.orphanTarget}、重复 ${unlocks.stats.duplicate}`,
    ]);
    s.line(`### 待站长处理：价格 ≥ 9999 被重置为免费的门控 ${st.priceReset.length} 个`);
    s.table(
      ["帖子 id", "原价格"],
      st.priceReset.slice(0, 60).map((r) => [r.postId, r.price]),
    );
    s.line(
      `### 待站长处理：未闭合的门控标签 ${st.unclosedGates.length} 个（失败即封闭：覆盖到文末）`,
    );
    s.table(
      ["帖子 id", "标签"],
      st.unclosedGates.map((r) => [r.postId, r.tag]),
    );
    s.line(`### 位于引用/列表内被丢弃的门控 ${st.nestedDropped.length} 个`);
    s.table(
      ["帖子 id", "位置"],
      st.nestedDropped.map((r) => [r.postId, r.detail]),
    );
    s.line("### 转换告警汇总");
    s.bullets([
      `样式降级（颜色/字号/背景/对齐/字体 → 纯文本，不再保留内联样式）：${st.warnings.get("style-degraded") ?? 0} 处`,
      `正文图片文件缺失（保留为无法解析的占位）：${st.warnings.get("image-unresolved") ?? 0} 处`,
    ]);
    s.table(["代码", "次数"], mapRows(st.warnings));
    s.line("### 附件与标签");
    s.bullets([
      `附件 ${ctx.attachments.length}（所属主题未迁移而丢弃 ${atts.stats.orphan}；回帖未迁移、改挂首帖 ${atts.stats.reattachedToFirstPost}；上传者缺失记为帖子作者 ${atts.stats.uploaderFromPostAuthor}；文件缺失丢弃 ${missingAtts.length}${missingAtts.length ? "：" + head(missingAtts, 10) : ""}）；文件本体由文件管线复制进内容寻址存储`,
      `标签 ${tags.tags.length}（空名/重复丢弃 ${tags.stats.emptyOrDuplicate}）；主题标签关联 ${tags.threadTags.length}（孤儿 ${tags.stats.orphanRelations}）`,
    ]);
    return {
      rows: content.threads.length + content.posts.length + content.gates.length,
      note: `${content.gates.length} 门控 / ${unlocks.rows.length} 解锁 / ${ph.users.length} 占位`,
    };
  },
};

// ---------- 积分与签到 ----------

export const pointsStep: Step = {
  name: "points",
  async run(ctx) {
    const userIds = await loadUserIds(ctx);
    const pts = transformPoints(
      await extractCreditBalances(),
      await extractBank(),
      userIds,
      ctx.asOf,
    );
    await load(
      "point_accounts",
      ["user_id", "balance", "lifetime_earned", "lifetime_spent", "updated_at"],
      pts.accounts.map((a) => ({
        user_id: a.userId,
        balance: a.balance,
        lifetime_earned: a.lifetimeEarned,
        lifetime_spent: a.lifetimeSpent,
        updated_at: a.updatedAt,
      })),
      ["user_id"],
    );
    await load(
      "point_ledger",
      ["user_id", "delta", "balance_after", "channel", "idempotency_key", "note", "created_at"],
      pts.ledger.map((l) => ({
        user_id: l.userId,
        delta: l.delta,
        balance_after: l.balanceAfter,
        channel: l.channel,
        idempotency_key: l.idempotencyKey,
        note: l.note,
        created_at: l.createdAt,
      })),
      ["idempotency_key"],
    );
    const checks = transformCheckins(await extractPunchLogs(), userIds);
    await load(
      "checkins",
      ["user_id", "checkin_date", "reward"],
      checks.rows.map((c) => ({
        user_id: c.userId,
        checkin_date: c.checkinDate,
        reward: c.reward,
      })),
      ["user_id", "checkin_date"],
    );
    await bumpAutoIncrement("point_ledger");

    const st = pts.stats;
    const s = ctx.report.section("积分与签到");
    s.line(
      `积分账户 ${st.users} 个，期初余额合计 ${st.total} = 旧 credit1 ${st.totalCredit1} + 银行存款本金 ${st.totalBank}（${st.bankAccounts} 户，活期+定期本金，不含利息）。` +
        `显示名「青翼币」。**不迁旧流水**（起点 2013-02 且与余额对不上）；羽毛、入住资格证、credit4–8 丢弃。`,
    );
    s.bullets([
      `负余额按 0 处理：${st.negativeClamped.length} 人（uid ${head(st.negativeClamped)}）`,
      `用户已不存在的余额 ${st.orphanBalances} 条、银行账户 ${st.orphanBank} 个，丢弃`,
      `签到：旧流水 ${checks.stats.logs} 条 → 按「用户×北京时间自然日」去重 ${checks.rows.length} 次（同日重复 ${checks.stats.sameDayDuplicates}、用户不存在 ${checks.stats.orphan}）`,
    ]);
    return {
      rows: pts.ledger.length + checks.rows.length,
      note: `${st.users} 账户 / ${checks.rows.length} 签到`,
    };
  },
};

// ---------- 徽章 ----------

export const badgesStep: Step = {
  name: "badges",
  async run(ctx) {
    const userIds = await loadUserIds(ctx);
    const holders = await newQuery<{ userId: number; roleKey: string }>(
      "SELECT user_id AS userId, role_key AS roleKey FROM user_roles WHERE scope_id = 0",
    );
    const res = transformBadges(
      await extractMedalInfo(),
      await extractMedalUsers(),
      holders,
      userIds,
      ctx.asOf,
    );
    await load(
      "badges",
      ["id", "key", "name", "description", "kind", "sort_order", "is_active"],
      res.badges.map((x) => ({
        id: x.id,
        key: x.key,
        name: x.name,
        description: x.description,
        kind: x.kind,
        sort_order: x.sortOrder,
        is_active: b(x.isActive),
      })),
      ["id"],
    );
    await load(
      "user_badges",
      ["user_id", "badge_id", "awarded_at", "expires_at"],
      res.userBadges.map((u) => ({
        user_id: u.userId,
        badge_id: u.badgeId,
        awarded_at: u.awardedAt,
        expires_at: u.expiresAt,
      })),
      ["user_id", "badge_id"],
    );
    await bumpAutoIncrement("badges");
    // 勋章图交给文件管线登记（files 步骤回填 icon_file_id）
    ctx.badgeIcons = new Map(
      res.badges.flatMap((x) => (x.iconSource ? [[x.id, x.iconSource] as const] : [])),
    );
    const st = res.stats;
    ctx.report
      .section("徽章")
      .line(
        `旧勋章 ${st.medals} 枚（纯展示，取消自动颁发）+ 团队徽章 ${st.teamBadges} 枚；` +
          `持有关系：勋章 ${st.holdings} 条（未知勋章引用 ${st.unknownMedalRefs}、用户不存在 ${st.orphanUsers}、已过期 ${st.expiredSkipped}，含注册后仅 3 天有效的欢迎勋章「社区居民」等）+ 团队徽章 ${st.teamHoldings} 条。`,
      );
    return { rows: res.badges.length + res.userBadges.length };
  },
};

// ---------- 社交：关注 / 点赞 / 投票 / 私信 ----------

export const followsStep: Step = {
  name: "follows",
  async run(ctx) {
    const res = transformFollows(
      await extractAttention(),
      await extractForumJoins(),
      await loadUserIds(ctx),
      await idSet("SELECT id FROM forums"),
      ctx.asOf,
    );
    await load(
      "follows",
      ["user_id", "target_type", "target_id", "created_at"],
      res.rows.map((r) => ({
        user_id: r.userId,
        target_type: r.targetType,
        target_id: r.targetId,
        created_at: r.createdAt,
      })),
      ["user_id", "target_type", "target_id"],
    );
    ctx.report
      .section("关注")
      .line(
        `关注用户 ${res.stats.users} + 加入版块 ${res.stats.forums}；引用已不存在的用户/版块 ${res.stats.invalid}、自关注 ${res.stats.self}、重复 ${res.stats.duplicate} 已丢弃。动态流表不迁。`,
      );
    return { rows: res.rows.length };
  },
};

export const reactionsStep: Step = {
  name: "reactions",
  async run(ctx) {
    const firstPosts = await newQuery<{ id: number; first_post_id: number }>(
      "SELECT id, first_post_id FROM threads",
    );
    const res = transformReactions(
      await extractLikes(),
      await idSet("SELECT id FROM posts"),
      new Map(firstPosts.map((t) => [Number(t.id), Number(t.first_post_id)])),
      await loadUserIds(ctx),
      ctx.asOf,
    );
    await load(
      "reactions",
      ["user_id", "post_id", "kind", "created_at"],
      res.rows.map((r) => ({
        user_id: r.userId,
        post_id: r.postId,
        kind: r.kind,
        created_at: r.createdAt,
      })),
      ["user_id", "post_id", "kind"],
    );
    ctx.report
      .section("点赞")
      .line(
        `点赞 ${res.rows.length} 条（主题→首帖 ${res.stats.thread}、回帖 ${res.stats.post}）；目标/用户已不存在 ${res.stats.orphan}、重复 ${res.stats.duplicate} 已丢弃。计数以明细重算。`,
      );
    return { rows: res.rows.length };
  },
};

export const pollsStep: Step = {
  name: "polls",
  async run(ctx) {
    const rawPolls = await extractPolls();
    const res = transformPolls(
      rawPolls,
      await extractPollOptions(),
      await extractPollVotes(),
      await idSet("SELECT id FROM threads"),
      await loadUserIds(ctx),
      ctx.asOf,
      new Map(rawPolls.map((p) => [Number(p.poll_id), Number(p.voter_num)])),
    );
    await load(
      "polls",
      [
        "id",
        "thread_id",
        "option_limit",
        "ends_at",
        "result_visibility",
        "voter_count",
        "created_by",
        "created_at",
      ],
      res.polls.map((p) => ({
        id: p.id,
        thread_id: p.threadId,
        option_limit: p.optionLimit,
        ends_at: p.endsAt,
        result_visibility: p.resultVisibility,
        voter_count: p.voterCount,
        created_by: p.createdBy,
        created_at: p.createdAt,
      })),
      ["id"],
    );
    await load(
      "poll_options",
      ["id", "poll_id", "content", "vote_count", "sort_order"],
      res.options.map((o) => ({
        id: o.id,
        poll_id: o.pollId,
        content: o.content,
        vote_count: o.voteCount,
        sort_order: o.sortOrder,
      })),
      ["id"],
    );
    await load(
      "poll_votes",
      ["poll_id", "option_id", "user_id", "created_at"],
      res.votes.map((v) => ({
        poll_id: v.pollId,
        option_id: v.optionId,
        user_id: v.userId,
        created_at: v.createdAt,
      })),
      ["poll_id", "option_id", "user_id"],
    );
    // 有投票的主题统一标记为 poll 类型
    if (res.polls.length > 0) {
      await newQuery(
        `UPDATE threads SET kind = 'poll' WHERE id IN (${res.polls.map((p) => p.threadId).join(",")})`,
      );
    }
    await bumpAutoIncrement("polls");
    await bumpAutoIncrement("poll_options");
    const st = res.stats;
    ctx.report
      .section("投票")
      .line(
        `投票 ${st.polls} 个 / 选项 ${res.options.length} / 投票记录 ${st.votesKept}。` +
          `丢弃：无对应主题 ${st.droppedNoThread}、同主题重复投票 ${st.droppedDuplicateThread}、选项 ${st.optionsDropped}、无效投票 ${st.votesInvalid}、重复投票 ${st.votesDuplicate}；` +
          `参与人数按实际记录重算，修正了 ${st.voterCountCorrected} 个投票的旧计数。`,
      );
    return { rows: res.polls.length + res.options.length + res.votes.length };
  },
};

export const messagesStep: Step = {
  name: "messages",
  async run(ctx) {
    const emojiIds = await extractEmojiIds();
    const res = transformConversations(
      await extractMessages(),
      await extractDialogs(),
      await loadUserIds(ctx),
      plainConverter(emojiIds),
      ctx.asOf,
    );
    await load(
      "conversations",
      ["id", "kind", "pair_key", "last_message_at", "created_at"],
      res.conversations.map((c) => ({
        id: c.id,
        kind: "direct",
        pair_key: c.pairKey,
        last_message_at: c.lastMessageAt,
        created_at: c.createdAt,
      })),
      ["id"],
    );
    await load(
      "conversation_members",
      ["conversation_id", "user_id", "last_read_message_id"],
      res.members.map((m) => ({
        conversation_id: m.conversationId,
        user_id: m.userId,
        last_read_message_id: m.lastReadMessageId,
      })),
      ["conversation_id", "user_id"],
    );
    await load(
      "messages",
      ["id", "conversation_id", "sender_id", "body", "created_at"],
      res.messages.map((m) => ({
        id: m.id,
        conversation_id: m.conversationId,
        sender_id: m.senderId,
        body: m.body,
        created_at: m.createdAt,
      })),
      ["id"],
    );
    await bumpAutoIncrement("conversations");
    await bumpAutoIncrement("messages");
    const st = res.stats;
    ctx.report
      .section("私信")
      .line(
        `真实用户私信 ${st.messages} 条 → 单聊会话 ${res.conversations.length} 个（含未读状态的成员 ${st.withUnread} 个）。` +
          `系统消息（uid 0，欢迎语与锁帖通知）${st.systemDropped} 条不进会话；用户已不存在 ${st.orphanUser}（含旧站已删除的虚拟账号 uid 1 的真人对话）、自发自收 ${st.self}、空内容 ${st.emptyDropped} 已丢弃。`,
      );
    return { rows: res.messages.length };
  },
};

// ---------- 计数重算 ----------

export const countersStep: Step = {
  name: "counters",
  async run(ctx) {
    const q = (sql: string) => newQuery(sql);
    // 点赞数、标签数、投票数以明细为准
    await q(`UPDATE posts SET like_count = 0`);
    await q(
      `UPDATE posts p JOIN (SELECT post_id, COUNT(*) c FROM reactions GROUP BY post_id) r ON r.post_id = p.id
       SET p.like_count = r.c`,
    );
    await q(
      `UPDATE tags t SET thread_count =
         (SELECT COUNT(*) FROM thread_tags tt JOIN threads th ON th.id = tt.thread_id
           WHERE tt.tag_id = t.id AND th.state = 'visible')`,
    );

    // 主题：回复数 = 可见回帖数；最后回复 = 可见帖子中楼层最大者（楼层按时间序分配）
    await q(
      `UPDATE threads t SET reply_count = (
         SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id AND p.floor > 1 AND p.state = 'visible')
       WHERE t.state <> 'spam'`,
    );
    await q(
      `UPDATE threads t JOIN posts p ON p.thread_id = t.id
       JOIN (SELECT thread_id, MAX(floor) mf FROM posts WHERE state = 'visible' GROUP BY thread_id) m
         ON m.thread_id = p.thread_id AND m.mf = p.floor
       SET t.last_post_id = p.id, t.last_poster_id = p.author_id, t.last_posted_at = p.created_at`,
    );
    await q(`UPDATE threads SET last_posted_at = created_at WHERE last_posted_at IS NULL`);

    // 版块：只统计可见主题/帖子；最后发表 = 可见主题里最近活跃者
    await q(
      `UPDATE forums f SET
         thread_count = (SELECT COUNT(*) FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible'),
         post_count = (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id
                        WHERE t.forum_id = f.id AND t.state = 'visible' AND p.state = 'visible'),
         last_post_id = (SELECT t.last_post_id FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible'
                          ORDER BY t.last_posted_at DESC, t.id DESC LIMIT 1),
         last_posted_at = (SELECT t.last_posted_at FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible'
                            ORDER BY t.last_posted_at DESC, t.id DESC LIMIT 1)`,
    );

    // 用户统计：为全部用户建行
    await q(
      `INSERT INTO user_stats (user_id, thread_count, post_count, digest_count, follower_count, last_post_at)
       SELECT u.id, COALESCE(t.c, 0), COALESCE(p.c, 0), COALESCE(t.d, 0), COALESCE(f.c, 0), p.last
       FROM users u
       LEFT JOIN (SELECT author_id, COUNT(*) c, SUM(digest > 0) d FROM threads
                   WHERE state = 'visible' GROUP BY author_id) t ON t.author_id = u.id
       LEFT JOIN (SELECT author_id, COUNT(*) c, MAX(created_at) last FROM posts
                   WHERE state = 'visible' GROUP BY author_id) p ON p.author_id = u.id
       LEFT JOIN (SELECT target_id, COUNT(*) c FROM follows
                   WHERE target_type = 'user' GROUP BY target_id) f ON f.target_id = u.id
       ON DUPLICATE KEY UPDATE thread_count = VALUES(thread_count), post_count = VALUES(post_count),
         digest_count = VALUES(digest_count), follower_count = VALUES(follower_count),
         last_post_at = VALUES(last_post_at)`,
    );

    const [row] = await newQuery<Record<string, number>>(
      `SELECT (SELECT COUNT(*) FROM user_stats) stats,
              (SELECT SUM(thread_count) FROM forums) forum_threads,
              (SELECT SUM(post_count) FROM forums) forum_posts,
              (SELECT SUM(like_count) FROM posts) likes`,
    );
    ctx.report
      .section("计数重算")
      .line(
        `全部计数由明细重算（旧计数在 50 个主题上对不上）：用户统计 ${row?.stats} 行；版块可见主题合计 ${row?.forum_threads}、可见帖子合计 ${row?.forum_posts}；点赞合计 ${row?.likes}。`,
      );
    return { rows: Number(row?.stats ?? 0) };
  },
};
