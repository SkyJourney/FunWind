/**
 * E2E 专用夹具（幂等）：补齐「自包含 E2E」所需、但不适合放进演示种子的场景。
 *
 * 为什么单独一份：演示种子（seed-data.ts）面向开发者本机的演示站，不该被几十个分页填充帖污染；
 * 而 E2E 要在 CI 里只靠 `bootstrap + db:seed + 本夹具` 跑通，不能依赖真实迁移数据。
 * 号段 950000+，与演示种子的 90000+/900000+ 不重叠；`apps/web/e2e/support/fixtures.ts` 里有同一份常量
 * （Playwright 以 CJS 加载，无法直接 import 本 ESM 模块，改动时两处同步）。
 *
 * 场景：公开版块（带主题前缀）、水区分页（60 个普通主题 + 1 个版块置顶）、全站置顶 ×3、
 * 历史表情、正文内联图、已注销作者、投票帖、带附件的帖、已删除主题、仅管理员可读的受限版块、头像、
 * 门控附件帖（付费 + 回复两个门控，附件分别绑定门控 / 公开，付费门控内另嵌一张门控图；demo_member 已购买付费门控）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { repoRoot } from "./env.js";
import {
  attachments,
  files,
  forumPrefixes,
  forums,
  gateUnlocks,
  pollOptions,
  polls,
  postGates,
  posts,
  siteSettings,
  threads,
  userProfiles,
  users,
} from "./schema.js";
import { incoming } from "./sql.js";

export const E2E_FIX = {
  section: 950,
  anime: 951, // 公开，带前缀「连载中」，放全站置顶与特殊帖
  water: 952, // 公开，60 个普通主题 → 3 页
  staff: 953, // restricted，且没有任何角色被授权（仅 admin 短路放行）
  prefixAiring: 9501,
  placeholderUser: 95001, // state=deleted 的「已注销用户」占位账号
  alice: 90001, // 演示种子里的用户（头像挂在她身上）
  member: 90005, // 演示种子里的用户：已购买门控附件帖的付费门控
  thread: {
    emoji: 950001,
    image: 950002,
    deletedAuthor: 950003,
    poll: 950004,
    attach: 950005,
    deletedState: 950006,
    staffSecret: 950007,
    /** 门控附件帖（docs/ATTACHMENT-GATES.md）：门控 a1 付费 10、a2 回复可见 */
    gateAttach: 950008,
    /** GFM 渲染帖（表格 / 删除线 / 语气词单波浪线） */
    gfm: 950009,
    globalPins: [950011, 950012, 950013],
    waterPin: 950021,
  },
  gate: { paid: 950081, reply: 950082 }, // post_gates.id
  waterFirst: 951001, // 水区普通主题 id 起点
  waterCount: 60,
} as const;

/** 1×1 透明 PNG（最小的合法图片，足够让浏览器真实解码 naturalWidth > 0） */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** 与 web 运行时同一套解析：STORAGE_DIR 优先，否则 <仓库根>/storage */
function storageRoot(): string {
  return process.env.STORAGE_DIR ? resolve(process.env.STORAGE_DIR) : join(repoRoot, "storage");
}

interface StoredFile {
  sha256: string;
  storageKey: string;
  mime: string;
  body: Buffer;
  ext: string;
}

function toStored(body: Buffer, ext: string, mime: string): StoredFile {
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    sha256,
    storageKey: `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${ext}`,
    mime,
    body,
    ext,
  };
}

/** 门控图片：合法 PNG 末尾追加标记字节（解码器忽略 IEND 之后的数据），哈希因此与普通图片不同 */
const PNG_GATED = Buffer.concat([PNG_1X1, Buffer.from("e2e-gated-image")]);

const AT = "2026-10-20 12:00:00";
/** 第 n 分钟的时间戳，保证列表排序确定 */
const minute = (n: number) =>
  `2026-10-20 ${String(10 + Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00`;

export async function seedE2eFixtures(db: Db, alice = E2E_FIX.alice): Promise<void> {
  const F = E2E_FIX;

  // ---------- 文件：先落盘，再登记 files 行 ----------
  const png = toStored(PNG_1X1, "png", "image/png");
  const txtA = toStored(Buffer.from("E2E 附件 A：字幕时间轴\n"), "txt", "text/plain");
  const txtB = toStored(Buffer.from("E2E 附件 B：术语表\n"), "txt", "text/plain");
  // 门控附件帖用的文件：内容各不相同，避免与其他帖按哈希去重后互相「放行」
  const gPaidZip = toStored(Buffer.from("E2E 付费附件：完整字幕包\n"), "txt", "text/plain");
  const gReplyZip = toStored(Buffer.from("E2E 回复可见附件\n"), "txt", "text/plain");
  const gPublicTxt = toStored(Buffer.from("E2E 门控帖里的公开附件\n"), "txt", "text/plain");
  const gImage = toStored(PNG_GATED, "png", "image/png");
  const stored = [png, txtA, txtB, gPaidZip, gReplyZip, gPublicTxt, gImage];
  for (const f of stored) {
    const dest = join(storageRoot(), f.storageKey);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.body);
  }
  await db
    .insert(files)
    .values(
      stored.map((f) => ({
        sha256: f.sha256,
        storageKey: f.storageKey,
        sizeBytes: f.body.length,
        mime: f.mime,
        width: f.ext === "png" ? 1 : null,
        height: f.ext === "png" ? 1 : null,
        createdAt: AT,
      })),
    )
    .onDuplicateKeyUpdate({ set: { mime: incoming("mime") } });
  const idOf = async (f: StoredFile) => {
    const [row] = await db
      .select({ id: files.id })
      .from(files)
      .where(sql`${files.sha256} = ${f.sha256}`);
    return row!.id;
  };
  const [pngId, txtAId, txtBId] = [await idOf(png), await idOf(txtA), await idOf(txtB)];
  const [paidZipId, replyZipId, publicTxtId, gImageId] = [
    await idOf(gPaidZip),
    await idOf(gReplyZip),
    await idOf(gPublicTxt),
    await idOf(gImage),
  ];

  // ---------- 用户：已注销占位账号 + 头像 ----------
  await db
    .insert(users)
    .values({
      id: F.placeholderUser,
      username: "e2e_deleted_placeholder",
      usernameKey: "e2e_deleted_placeholder",
      state: "deleted",
      createdAt: AT,
    })
    .onDuplicateKeyUpdate({ set: { state: incoming("state") } });
  await db
    .insert(userProfiles)
    .values({ userId: alice, avatarFileId: pngId })
    .onDuplicateKeyUpdate({ set: { avatarFileId: incoming("avatar_file_id") } });

  // ---------- 版块 ----------
  await db
    .insert(forums)
    .values([
      {
        id: F.section,
        parentId: 0,
        path: "/950/",
        depth: 1,
        kind: "section",
        name: "『E2E 区』",
        sortOrder: 950,
      },
      {
        id: F.anime,
        parentId: F.section,
        path: "/950/951/",
        depth: 2,
        name: "『E2E 动画』",
        description: "E2E：公开版块，带主题前缀",
        sortOrder: 1,
      },
      {
        id: F.water,
        parentId: F.section,
        path: "/950/952/",
        depth: 2,
        name: "『E2E 水区』",
        description: "E2E：分页与置顶",
        sortOrder: 2,
      },
      {
        id: F.staff,
        parentId: F.section,
        path: "/950/953/",
        depth: 2,
        name: "『E2E 站务组』",
        description: "E2E：仅管理员可读",
        sortOrder: 3,
        readPolicy: "restricted",
        writePolicy: "restricted",
      },
    ])
    .onDuplicateKeyUpdate({
      set: {
        name: incoming("name"),
        readPolicy: incoming("read_policy"),
        writePolicy: incoming("write_policy"),
      },
    });
  await db
    .insert(forumPrefixes)
    .values({ id: F.prefixAiring, forumId: F.anime, name: "连载中", sortOrder: 1 })
    .onDuplicateKeyUpdate({ set: { name: incoming("name") } });

  // ---------- 主题与首帖 ----------
  interface T {
    id: number;
    forumId: number;
    authorId: number;
    title: string;
    body: string;
    at: string;
    pinLevel?: number;
    kind?: "normal" | "poll";
    state?: "visible" | "deleted";
    prefixId?: number;
    hasGate?: boolean;
  }
  const specials: T[] = [
    {
      id: F.thread.emoji,
      forumId: F.anime,
      authorId: alice,
      title: "E2E 表情帖",
      body: "历史表情码展开后的静态图：![表情](/emoji/120.gif)",
      at: minute(1),
      prefixId: F.prefixAiring,
    },
    {
      id: F.thread.image,
      forumId: F.anime,
      authorId: alice,
      title: "E2E 正文图片帖",
      body: `正文内联图：\n\n![图](/files/${png.storageKey})`,
      at: minute(2),
    },
    {
      id: F.thread.deletedAuthor,
      forumId: F.anime,
      authorId: F.placeholderUser,
      title: "E2E 已注销作者帖",
      body: "原作者账号已不存在。",
      at: minute(3),
    },
    {
      id: F.thread.poll,
      forumId: F.anime,
      authorId: alice,
      title: "E2E 投票帖",
      body: "请投票。",
      at: minute(4),
      kind: "poll",
    },
    {
      id: F.thread.attach,
      forumId: F.anime,
      authorId: alice,
      title: "E2E 附件帖",
      body: "带两个文本附件。",
      at: minute(5),
    },
    {
      id: F.thread.deletedState,
      forumId: F.anime,
      authorId: alice,
      title: "E2E 已删除主题",
      body: "不应被任何人读到。",
      at: minute(6),
      state: "deleted",
    },
    {
      id: F.thread.staffSecret,
      forumId: F.staff,
      authorId: alice,
      title: "[内部] E2E 站务议程",
      body: "仅管理员可见。",
      at: minute(7),
    },
    {
      id: F.thread.gfm,
      forumId: F.anime,
      authorId: alice,
      title: "E2E GFM 渲染帖",
      body: [
        "表格：",
        "",
        "| 名称 | 数量 |",
        "| --- | ---: |",
        "| 苹果 | 3 |",
        "| 梨 | 5 |",
        "",
        "~~已划掉~~ 与语气词~我也是~好在，更新到第1~12集。",
      ].join("\n"),
      at: minute(9),
    },
    {
      id: F.thread.gateAttach,
      forumId: F.anime,
      authorId: alice,
      title: "E2E 门控附件帖",
      // 门控处只留占位；隐藏正文在下方 post_gates
      body: '公开说明。\n\n:::gate{key="a1"}\n:::\n\n:::gate{key="a2"}\n:::',
      at: minute(8),
      hasGate: true,
    },
    ...F.thread.globalPins.map((id, i) => ({
      id,
      forumId: F.anime,
      authorId: alice,
      title: `E2E 全站置顶 ${i + 1}`,
      body: "全站置顶。",
      at: minute(10 + i),
      pinLevel: 3,
    })),
    {
      id: F.thread.waterPin,
      forumId: F.water,
      authorId: alice,
      title: "E2E 水区置顶",
      body: "版块置顶。",
      at: minute(20),
      pinLevel: 1,
    },
  ];
  const water: T[] = Array.from({ length: F.waterCount }, (_, i) => ({
    id: F.waterFirst + i,
    forumId: F.water,
    authorId: alice,
    title: `E2E 水区主题 ${String(i + 1).padStart(2, "0")}`,
    body: `水区第 ${i + 1} 帖。`,
    at: minute(30 + i),
  }));
  const all = [...specials, ...water];
  const postIdOf = (tid: number) => 9_000_000 + tid; // 首帖 id 由主题 id 派生，便于夹具互相引用

  await db
    .insert(threads)
    .values(
      all.map((t) => ({
        id: t.id,
        forumId: t.forumId,
        authorId: t.authorId,
        title: t.title,
        prefixId: t.prefixId ?? null,
        kind: t.kind ?? ("normal" as const),
        firstPostId: postIdOf(t.id),
        state: t.state ?? ("visible" as const),
        pinLevel: t.pinLevel ?? 0,
        lastPostId: postIdOf(t.id),
        lastPosterId: t.authorId,
        lastPostedAt: t.at,
        createdAt: t.at,
      })),
    )
    .onDuplicateKeyUpdate({
      set: { title: incoming("title"), state: incoming("state"), pinLevel: incoming("pin_level") },
    });
  await db
    .insert(posts)
    .values(
      all.map((t) => ({
        id: postIdOf(t.id),
        threadId: t.id,
        floor: 1,
        authorId: t.authorId,
        bodyMd: t.body,
        hasGate: t.hasGate ?? false,
        state: t.state ?? ("visible" as const),
        createdAt: t.at,
      })),
    )
    .onDuplicateKeyUpdate({
      set: { bodyMd: incoming("body_md"), hasGate: incoming("has_gate"), state: incoming("state") },
    });

  // ---------- 投票 ----------
  await db
    .insert(polls)
    .values({
      id: F.thread.poll,
      threadId: F.thread.poll,
      optionLimit: 1,
      createdBy: alice,
      createdAt: minute(4),
    })
    .onDuplicateKeyUpdate({ set: { optionLimit: incoming("option_limit") } });
  await db
    .insert(pollOptions)
    .values([
      { id: F.thread.poll * 10 + 1, pollId: F.thread.poll, content: "选项一", sortOrder: 1 },
      { id: F.thread.poll * 10 + 2, pollId: F.thread.poll, content: "选项二", sortOrder: 2 },
    ])
    .onDuplicateKeyUpdate({ set: { content: incoming("content") } });

  // ---------- 附件（两个 txt） ----------
  await db
    .insert(attachments)
    .values([
      {
        id: F.thread.attach * 10 + 1,
        postId: postIdOf(F.thread.attach),
        fileId: txtAId,
        uploaderId: alice,
        originalName: "时间轴.txt",
        createdAt: minute(5),
      },
      {
        id: F.thread.attach * 10 + 2,
        postId: postIdOf(F.thread.attach),
        fileId: txtBId,
        uploaderId: alice,
        originalName: "术语表.txt",
        createdAt: minute(5),
      },
    ])
    .onDuplicateKeyUpdate({ set: { originalName: incoming("original_name") } });

  // ---------- 门控附件帖：两个门控 + 绑定门控 / 公开的附件 ----------
  const gatePost = postIdOf(F.thread.gateAttach);
  await db
    .insert(postGates)
    .values([
      {
        id: F.gate.paid,
        postId: gatePost,
        gateKey: "a1",
        conditions: [{ type: "points", price: 10 }],
        // 隐藏块里内嵌一张门控图（与迁移数据里「门控内引用的图片附件」同形）
        hiddenMd: `E2E 付费可见正文。\n\n![门控图](/files/${gImage.storageKey})`,
        unlockCount: 1,
        createdAt: minute(8),
        updatedAt: minute(8),
      },
      {
        id: F.gate.reply,
        postId: gatePost,
        gateKey: "a2",
        conditions: [{ type: "reply" }],
        hiddenMd: "E2E 回复可见正文。",
        createdAt: minute(8),
        updatedAt: minute(8),
      },
    ])
    .onDuplicateKeyUpdate({
      set: { hiddenMd: incoming("hidden_md"), unlockCount: incoming("unlock_count") },
    });
  await db
    .insert(gateUnlocks)
    .values({
      gateId: F.gate.paid,
      userId: F.member,
      pricePaid: 10,
      authorIncome: 10,
      unlockedAt: minute(9),
    })
    .onDuplicateKeyUpdate({ set: { pricePaid: incoming("price_paid") } });
  const attId = F.thread.gateAttach * 10;
  await db
    .insert(attachments)
    .values([
      {
        id: attId + 1,
        postId: gatePost,
        gateId: null,
        fileId: publicTxtId,
        uploaderId: alice,
        originalName: "公开附件.txt",
        createdAt: minute(8),
      },
      {
        id: attId + 2,
        postId: gatePost,
        gateId: F.gate.paid,
        fileId: paidZipId,
        uploaderId: alice,
        originalName: "付费附件.txt",
        createdAt: minute(8),
      },
      {
        id: attId + 3,
        postId: gatePost,
        gateId: F.gate.paid,
        fileId: gImageId,
        uploaderId: alice,
        originalName: "门控图.png",
        createdAt: minute(8),
      },
      {
        id: attId + 4,
        postId: gatePost,
        gateId: F.gate.reply,
        fileId: replyZipId,
        uploaderId: alice,
        originalName: "回复可见附件.txt",
        createdAt: minute(8),
      },
    ])
    .onDuplicateKeyUpdate({
      set: { originalName: incoming("original_name"), gateId: incoming("gate_id") },
    });

  // ---------- 站点设置：积分显示名 ----------
  // 门控 E2E 的文案断言（“已购买 · 10 青翼币”）依赖它；原来由迁移写入，自包含后改由夹具负责。
  // 不放进演示种子：演示种子的默认语义是中性的“积分”（queries.int.test 断言了这一点）。
  await db
    .insert(siteSettings)
    .values({ key: "points.name", value: { name: "青翼币" }, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: incoming("value") } });

  // ---------- 版块计数缓存（可由 threads 重算，这里按夹具实际数据对齐） ----------
  for (const fid of [F.anime, F.water, F.staff]) {
    await db.execute(sql`
      UPDATE forums f SET
        thread_count = (SELECT COUNT(*) FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible'),
        post_count = (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id WHERE t.forum_id = f.id AND p.state = 'visible'),
        last_post_id = (SELECT MAX(first_post_id) FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible'),
        last_posted_at = (SELECT MAX(last_posted_at) FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible')
      WHERE f.id = ${fid}`);
  }
}
