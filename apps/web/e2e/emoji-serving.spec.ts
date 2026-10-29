import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";

/**
 * /emoji 提供路由（M10.9 Step 3，dev 服务器）：
 *   · 旧 50 枚是 public/emoji/{id}.gif 静态文件，静态优先于路由——库里没有 120 行，
 *     200 即证明 public 先于 app/emoji/[file] 命中（生产构建的对应实测在 e2e-prod/prod.spec.ts）；
 *   · 新表情路由全分支：200 全套头、304、ext 不一致 404、不存在 404、停用仍 200、不合式 404；
 *   · /emoji/** 不被全站头叠加（自带 sandbox + immutable，与 /files 同待遇）。
 * 表情行与文件由本用例自造自清（id 951901，不与迁移 id 120–169 与其它夹具冲突）。
 */

test.describe.configure({ mode: "serial" });

const EMOJI_ID = 951901;
const GROUP_NAME = `E2E 表情组 ${EMOJI_ID}`;
// 根 test:e2e 编排固定 export STORAGE_DIR=storage-e2e；直接单跑 spec 时回退到同一目录，保持 E2E 存储隔离
const STORAGE = process.env.STORAGE_DIR
  ? resolve(process.env.STORAGE_DIR)
  : resolve(__dirname, "../../../storage-e2e");

let sha256 = "";

test.beforeAll(async () => {
  const bytes = Buffer.from(`e2e-emoji-${EMOJI_ID}`);
  sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.png`;
  // 与被测服务器同一 STORAGE_DIR（test:e2e 编排固定指向 storage-e2e）
  mkdirSync(join(STORAGE, sha256.slice(0, 2), sha256.slice(2, 4)), { recursive: true });
  writeFileSync(join(STORAGE, key), bytes);
  await withE2eDb(async (q) => {
    const g = await q.exec(
      "INSERT INTO emoji_groups (name, sort, enabled, created_at, updated_at) VALUES (?, 0, 1, NOW(), NOW())",
      [GROUP_NAME],
    );
    await q.exec(
      "INSERT INTO emojis (id, group_id, name, keywords, ext, storage_key, enabled, created_at, updated_at) " +
        "VALUES (?, ?, 'E2E 新表情', '', 'png', ?, 1, NOW(), NOW())",
      [EMOJI_ID, g.insertId, key],
    );
  });
});

test.afterAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM emojis WHERE id = ?", [EMOJI_ID]);
    await q.exec("DELETE FROM emoji_groups WHERE name = ?", [GROUP_NAME]);
  });
});

test("旧 50 枚静态优先：public/emoji/120.gif 200，自带 sandbox + immutable，无全站头叠加", async ({
  request,
}) => {
  const res = await request.get("/emoji/120.gif");
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h["content-type"]).toBe("image/gif");
  expect(h["content-security-policy"]).toBe("default-src 'none'; sandbox");
  expect(h["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["content-security-policy-report-only"]).toBeUndefined();
  expect(h["x-frame-options"]).toBeUndefined();
});

test("新表情 200：内容一致 + ETag（内容寻址）+ inline", async ({ request }) => {
  const res = await request.get(`/emoji/${EMOJI_ID}.png`);
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h["content-type"]).toBe("image/png");
  expect(h["content-disposition"]).toBe("inline");
  expect(h["etag"]).toBe(`"${sha256}"`);
  expect(h["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(h["content-security-policy"]).toBe("default-src 'none'; sandbox");
  expect(await res.text()).toBe(`e2e-emoji-${EMOJI_ID}`);
});

test("If-None-Match 命中 → 304", async ({ request }) => {
  const res = await request.get(`/emoji/${EMOJI_ID}.png`, {
    headers: { "if-none-match": `"${sha256}"` },
  });
  expect(res.status()).toBe(304);
});

test("停用后面板会消失，但已发布正文不能碎：enabled=0 仍 200", async ({ request }) => {
  await withE2eDb((q) => q.exec("UPDATE emojis SET enabled = 0 WHERE id = ?", [EMOJI_ID]));
  expect((await request.get(`/emoji/${EMOJI_ID}.png`)).status()).toBe(200);
});

test("404 分支：ext 不一致 / 不存在 / 路径不合式", async ({ request }) => {
  for (const p of [
    `/emoji/${EMOJI_ID}.gif`, // ext 与库内不一致
    "/emoji/951902.png", // 库里不存在
    "/emoji/abc.gif", // 不合式：非数字
    `/emoji/${EMOJI_ID}.jpeg`, // 不合式：扩展名不在受控词汇
    `/emoji/${EMOJI_ID}`, // 不合式：无扩展名
    `/emoji/${EMOJI_ID}.GIF`, // 不合式：大写
    "/emoji/-1.png", // 不合式：负数
  ]) {
    expect((await request.get(p)).status(), p).toBe(404);
  }
});
