#!/usr/bin/env node
/**
 * 「茉莉」表情组的一次性数据收敛（站长 2026-10-29 拍板，M10.9 追加）：
 *   1. 建/取单组「茉莉」（旧分类「茉莉 01 / 茉莉 02」合并）；
 *   2. 50 枚旧表情（id 120–169）挂入该组并改名——名称 = 迁移包 transform/emoji-names.ts 的读图拍板名；
 *   3. 分组标题图：从 142（星星眼）提取一帧生成独立图片，内容寻址落盘 + files 登记，写入 icon_key；
 *   4. 删除已空的旧两组；每步同事务写 audit_log（actor NULL = CLI，与 backfill-forum-policies 同口径）。
 *
 * 幂等：组按名、表情按 id、标题图按 icon_key 已设跳过（传 --force-icon 覆盖）；重跑结果一致。
 * 名字表与迁移器同源（同一文件），重导（迁移器写终态名）与本脚本（存量库收敛）结果一致。
 * 跑完后执行 `pnpm --filter @funwind/migration exec tsx src/backfill-emoji-alt.ts` 刷新全站 alt。
 *
 * 运行：pnpm --filter @funwind/web exec tsx scripts/emoji-rename.ts
 */
import { existsSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { sql } from "drizzle-orm";
import { auditLog, emojiGroups, emojis, files, getWebDb, withDb } from "@funwind/db";

// 跨包复用迁移器的读图拍板名：migration 包无构建产物（直接 tsx 跑源码），tsx 运行时能转译
// 包外 .ts 源，但 tsc 不解析 include 外的相对模块——用动态导入 + expect-error 压制，类型在此手写断言
async function loadNames(): Promise<{
  EMOJI_NAMES: Readonly<Record<number, string>>;
  GROUP_ICON_EMOJI_ID: number;
}> {
  return import(
    // 跨包相对源码：tsc 经 .js → .ts 映射解析（migration 无构建产物）
    "../../../migration/src/transform/emoji-names.js"
  );
}

const GROUP_NAME = "茉莉";
const OLD_GROUP_NAMES = ["茉莉 01", "茉莉 02"];
const REPO_ROOT = path.resolve(process.cwd(), "../..");
const PUBLIC_EMOJI_DIR = path.join(REPO_ROOT, "apps/web/public/emoji");
const STORAGE_DIR = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(REPO_ROOT, "storage");

type Tx = Parameters<Parameters<ReturnType<typeof getWebDb>["transaction"]>[0]>[0];

/** CLI 审计：actor NULL = 命令行（web 侧 writeAudit 走 lib/audit，约束的是运行时；离线脚本直插同表） */
async function audit(
  tx: Tx,
  action: string,
  targetId: string | number,
  after: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditLog).values({
    actorId: null,
    action,
    targetType: "emoji_group",
    targetId: String(targetId),
    afterJson: after as object,
    createdAt: sql`NOW()`,
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 内容寻址落盘（与 lib/uploads/store.ts 同规则：已存在则不写，临时文件再原子 rename） */
async function writeContentAddressed(key: string, bytes: Buffer): Promise<void> {
  const finalPath = path.join(STORAGE_DIR, key);
  if (existsSync(finalPath)) return;
  await mkdir(path.dirname(finalPath), { recursive: true });
  const tmpDir = path.join(STORAGE_DIR, ".tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, randomBytes(12).toString("hex"));
  await writeFile(tmpPath, bytes);
  await rename(tmpPath, finalPath);
}

main().catch((e: unknown) => {
  console.error("失败：", e);
  process.exit(1);
});

async function main(): Promise<void> {
  const { EMOJI_NAMES, GROUP_ICON_EMOJI_ID } = await loadNames();
  await withDb(async ({ db }) => {
    // 1. 建/取单组「茉莉」
    let [group] = await db
      .select()
      .from(emojiGroups)
      .where(sql`name = ${GROUP_NAME}`)
      .limit(1);
    if (!group) {
      const [ins] = (await db.insert(emojiGroups).values({
        name: GROUP_NAME,
        sort: 0,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })) as unknown as [{ insertId: number }];
      [group] = await db
        .select()
        .from(emojiGroups)
        .where(sql`id = ${ins.insertId}`)
        .limit(1);
      await db.transaction(async (tx) => {
        await audit(tx, "admin.emoji.group.create", ins.insertId, {
          name: GROUP_NAME,
          via: "cli",
          note: "站长拍板：旧分类茉莉 01/02 合并为单组",
        });
      });
      console.log(`✔ 已建分组「${GROUP_NAME}」(#${ins.insertId})`);
    } else {
      console.log(`✔ 分组「${GROUP_NAME}」已存在 (#${group!.id})`);
    }

    // 2. 50 枚挂组 + 改名（逐行审计；重跑时全部跳过）
    const rows = await db.select().from(emojis);
    let renamed = 0;
    let moved = 0;
    let touched = 0;
    const missing: number[] = [];
    for (let id = 120; id <= 169; id++) {
      const row = rows.find((r) => r.id === id);
      if (!row) {
        missing.push(id);
        continue;
      }
      const name = EMOJI_NAMES[id] ?? `旧表情 ${id}`;
      if (row.name !== name || row.groupId !== group!.id) {
        touched++;
        await db.transaction(async (tx) => {
          await tx
            .update(emojis)
            .set({ name, groupId: group!.id, updatedAt: sql`NOW()` })
            .where(sql`id = ${id}`);
          await tx.insert(auditLog).values({
            actorId: null,
            action: "admin.emoji.rename",
            targetType: "emoji",
            targetId: String(id),
            beforeJson: { name: row.name, groupId: row.groupId } as object,
            afterJson: { name, groupId: group!.id, via: "cli" } as object,
            createdAt: sql`NOW()`,
          });
        });
        if (row.name !== name) renamed++;
        if (row.groupId !== group!.id) moved++;
      }
    }
    console.log(
      `✔ 50 枚收敛完成：改名 ${renamed}、挂组 ${moved}、本就一致 ${50 - touched}；缺失 ${missing.length}${missing.length ? `（${missing.join(",")}）` : ""}`,
    );

    // 3. 分组标题图：142 首帧 → png → 内容寻址 → files → icon_key
    if (group!.iconKey && !process.argv.includes("--force-icon")) {
      console.log(`✔ 标题图已设置（${group!.iconKey}），跳过（--force-icon 覆盖）`);
    } else {
      const src = path.join(PUBLIC_EMOJI_DIR, `${GROUP_ICON_EMOJI_ID}.gif`);
      const png = await sharp(src, { pages: 1 }).png().toBuffer();
      const sha = sha256Hex(png);
      const key = `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.png`;
      await writeContentAddressed(key, png);
      await db
        .insert(files)
        .ignore()
        .values({
          sha256: sha,
          storageKey: key,
          sizeBytes: png.byteLength,
          mime: "image/png",
          width: 80,
          height: 80,
          createdAt: sql`NOW()`,
        });
      await db.transaction(async (tx) => {
        await tx
          .update(emojiGroups)
          .set({ iconKey: key, updatedAt: sql`NOW()` })
          .where(sql`id = ${group!.id}`);
        await audit(tx, "admin.emoji.group.icon", group!.id, {
          iconKey: key,
          source: `/emoji/${GROUP_ICON_EMOJI_ID}.gif 首帧`,
          via: "cli",
        });
      });
      const onDisk = await stat(path.join(STORAGE_DIR, key)).then(
        () => true,
        () => false,
      );
      console.log(
        `✔ 标题图已生成（${GROUP_ICON_EMOJI_ID} 首帧 80×80 → ${key}，落盘${onDisk ? "成功" : "失败!"}）`,
      );
    }

    // 4. 删除已空的旧两组
    for (const old of OLD_GROUP_NAMES) {
      const [g] = await db
        .select()
        .from(emojiGroups)
        .where(sql`name = ${old}`)
        .limit(1);
      if (!g) continue;
      const [{ n }] = await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(emojis)
        .where(sql`group_id = ${g.id}`);
      if (Number(n) > 0) {
        console.warn(`⚠ 旧分组「${old}」(#${g.id}) 仍有 ${n} 个成员，不删除——请人工核查`);
        continue;
      }
      await db.transaction(async (tx) => {
        await tx.delete(emojiGroups).where(sql`id = ${g.id}`);
        await audit(tx, "admin.emoji.group.delete", g.id, { name: old, via: "cli" });
      });
      console.log(`✔ 已删旧分组「${old}」(#${g.id})`);
    }

    console.log(
      "完成。请随后执行 alt 回填刷新全站：pnpm --filter @funwind/migration exec tsx src/backfill-emoji-alt.ts",
    );
  });
}
