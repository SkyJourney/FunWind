import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";
import { USERS, loginAs } from "./support/session";

/**
 * /files 路由与附件渲染 E2E。
 *   · 图片类（头像、正文图片）公开，响应头安全（mime 取自数据库、nosniff、CSP sandbox、ETag/304）；
 *   · 非图片附件：游客只看到「登录后下载」（无链接），会员下载 200 且计数累加，受限版块的附件对无权者 404。
 * 夹具：E2E 夹具帖 FIX.thread.attach 带两个 txt 附件、alice 挂有头像、FIX.thread.image 含正文内联图；
 * 受限版块 904 的帖 900105 的附件由用例造（含真实文件落盘，结束后清理）。
 */

// 存储根目录：与 web 服务器同一个 STORAGE_DIR（根脚本 test:e2e:run 导出，指向 <仓库根>/storage-e2e，与开发目录隔离）
const STORAGE = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.resolve(__dirname, "../../../storage-e2e");
const SECRET_BODY = "SECRET-ZIP-E2E-内部资料";
const SECRET_SHA = createHash("sha256").update(SECRET_BODY).digest("hex");
const SECRET_KEY = `${SECRET_SHA.slice(0, 2)}/${SECRET_SHA.slice(2, 4)}/${SECRET_SHA}.zip`;
const SECRET_NAME = "内部分工表.zip";

test.beforeAll(async () => {
  mkdirSync(path.join(STORAGE, SECRET_SHA.slice(0, 2), SECRET_SHA.slice(2, 4)), {
    recursive: true,
  });
  writeFileSync(path.join(STORAGE, SECRET_KEY), SECRET_BODY);
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM attachments WHERE original_name = ?", [SECRET_NAME]);
    await q.exec("DELETE FROM files WHERE sha256 = ?", [SECRET_SHA]);
    const f = await q.exec(
      "INSERT INTO files (sha256, storage_key, size_bytes, mime, created_at) VALUES (?, ?, ?, 'application/zip', NOW())",
      [SECRET_SHA, SECRET_KEY, Buffer.byteLength(SECRET_BODY)],
    );
    await q.exec(
      "INSERT INTO attachments (post_id, file_id, uploader_id, original_name, created_at) VALUES (900105, ?, ?, ?, NOW())",
      [f.insertId, USERS.team, SECRET_NAME],
    );
  });
});

test.afterAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM attachments WHERE original_name = ?", [SECRET_NAME]);
    await q.exec("DELETE FROM files WHERE sha256 = ?", [SECRET_SHA]);
  });
  rmSync(path.join(STORAGE, SECRET_KEY), { force: true });
});

const txtAttachmentKeys = () =>
  withE2eDb((q) =>
    q.query<{ storage_key: string }>(
      `SELECT f.storage_key FROM attachments a JOIN files f ON f.id = a.file_id
        JOIN posts p ON p.id = a.post_id WHERE p.thread_id = ${FIX.thread.attach} ORDER BY a.id`,
    ),
  );

test.describe("图片（公开）", () => {
  test("正文图片：200、类型来自库、nosniff、CSP sandbox、inline、ETag；If-None-Match 命中返回 304", async ({
    page,
    request,
  }) => {
    await page.goto(`/t/${FIX.thread.image}`);
    const src = (await page
      .locator('.content-md img[src^="/files/"]')
      .first()
      .getAttribute("src"))!;
    const res = await request.get(src);
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h["content-type"]).toMatch(/^image\//);
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(h["content-disposition"]).toBe("inline");
    expect(h["cache-control"]).toContain("immutable");
    expect(h["etag"]).toMatch(/^"[0-9a-f]{64}"$/);

    const cond = await request.get(src, { headers: { "if-none-match": h["etag"]! } });
    expect(cond.status()).toBe(304);
    expect((await cond.body()).length).toBe(0);
  });

  test("头像：个人页显示 /files/ 头像且真实加载", async ({ page }) => {
    const [row] = await withE2eDb((q) =>
      q.query<{ user_id: number }>(
        `SELECT p.user_id FROM user_profiles p JOIN users u ON u.id = p.user_id
          WHERE p.avatar_file_id IS NOT NULL AND u.state = 'active' ORDER BY p.user_id LIMIT 1`,
      ),
    );
    await page.goto(`/u/${row!.user_id}`);
    const avatar = page.locator('main img[src^="/files/"]').first();
    await expect(avatar).toHaveCount(1);
    await expect
      .poll(() => avatar.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
  });

  test("非法 / 不存在的 key 与旧路由：404", async ({ request }) => {
    for (const p of [
      "/files/aa/aa/xx.png",
      `/files/aa/bb/${"a".repeat(64)}.png`,
      `/files/aa/aa/${"a".repeat(64)}.png`,
      "/attachment/avatar/000/00/00/1.jpg",
      "/emotion/01/17.gif",
    ]) {
      expect((await request.get(p)).status(), p).toBe(404);
    }
  });
});

test.describe("附件（须有权限）", () => {
  test("游客：看到附件名与「登录后下载」，页面里没有可点击的 /files 链接；直接请求也是 404", async ({
    page,
    request,
  }) => {
    await page.goto(`/t/${FIX.thread.attach}`);
    await expect(page.getByText("登录后下载")).toHaveCount(2);
    await expect(page.locator('a[href^="/files/"][href$=".txt"]')).toHaveCount(0);
    for (const { storage_key } of await txtAttachmentKeys()) {
      expect((await request.get(`/files/${storage_key}`)).status()).toBe(404);
    }
  });

  test("会员：看到下载链接；下载 200，附件下载头，且下载计数累加", async ({ page, context }) => {
    await loginAs(context, USERS.member);
    await page.goto(`/t/${FIX.thread.attach}`);
    const link = page.locator('a[href^="/files/"][href$=".txt"]').first();
    await expect(link).toBeVisible();
    const before = Number((await link.innerText()).match(/（(\d+) 次下载）/)![1]);

    const res = await page.request.get((await link.getAttribute("href"))!);
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h["content-type"]).toBe("text/plain");
    expect(h["content-disposition"]).toMatch(
      /^attachment; filename="download"; filename\*=UTF-8''/,
    );
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["cache-control"]).toBe("private, no-store");
    expect((await res.body()).length).toBeGreaterThan(0);

    await page.reload();
    const after = Number(
      (await page.locator('a[href^="/files/"][href$=".txt"]').first().innerText()).match(
        /（(\d+) 次下载）/,
      )![1],
    );
    expect(after).toBe(before + 1);
  });

  test("受限版块的附件：游客与普通会员 404；有权限的团队成员与 admin 200 且内容正确", async ({
    page,
    context,
    request,
  }) => {
    // 游客
    expect((await request.get(`/files/${SECRET_KEY}`)).status()).toBe(404);
    // 普通会员（有全局 attachment.download，但读不到 904 版块）
    await loginAs(context, USERS.member);
    expect((await page.request.get(`/files/${SECRET_KEY}`)).status()).toBe(404);

    // 团队成员：主题页显示可点击链接，下载内容正确，文件名经 RFC 5987 编码
    await context.clearCookies();
    await loginAs(context, USERS.team);
    await page.goto("/t/900005");
    await expect(page.getByRole("link", { name: new RegExp(SECRET_NAME) })).toBeVisible();
    const ok = await page.request.get(`/files/${SECRET_KEY}`);
    expect(ok.status()).toBe(200);
    expect(await ok.text()).toBe(SECRET_BODY);
    expect(decodeURIComponent(ok.headers()["content-disposition"]!.split("UTF-8''")[1]!)).toBe(
      SECRET_NAME,
    );

    await context.clearCookies();
    await loginAs(context, USERS.admin);
    expect((await page.request.get(`/files/${SECRET_KEY}`)).status()).toBe(200);
  });
});

test("受限版块的内联图与缩略图（M6.4c）：游客与普通会员 404；团队成员 200 且私有；缩略图鉴权与原图一致", async ({
  browser,
  request,
}) => {
  const buf = await sharp({
    create: { width: 600, height: 400, channels: 3, background: "#336699" },
  })
    .png()
    .toBuffer();
  const sha = createHash("sha256").update(buf).digest("hex");
  const key = `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.png`;
  mkdirSync(path.join(STORAGE, sha.slice(0, 2), sha.slice(2, 4)), { recursive: true });
  writeFileSync(path.join(STORAGE, key), buf);
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM files WHERE sha256 = ?", [sha]);
    const f = await q.exec(
      "INSERT INTO files (sha256, storage_key, size_bytes, mime, width, height, created_at) VALUES (?, ?, ?, 'image/png', 600, 400, NOW())",
      [sha, key, buf.length],
    );
    await q.exec(
      "INSERT INTO attachments (post_id, file_id, uploader_id, original_name, kind, created_at) VALUES (900105, ?, ?, 'inline.png', 'inline', NOW())",
      [f.insertId, USERS.team],
    );
  });
  try {
    // 匿名与普通会员：原图与缩略图都是 404
    expect((await request.get(`/files/${key}`)).status()).toBe(404);
    expect((await request.get(`/files/${key}?w=320`)).status()).toBe(404);
    const member = await browser.newContext();
    await loginAs(member, USERS.member);
    expect((await member.request.get(`/files/${key}?w=320`)).status()).toBe(404);
    await member.close();

    // 团队成员：200，私有缓存，不带 ETag；缩略图宽度正确
    const team = await browser.newContext();
    await loginAs(team, USERS.team);
    const res = await team.request.get(`/files/${key}?w=320`);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("private, no-store");
    expect(res.headers()["etag"]).toBeUndefined();
    expect((await sharp(await res.body()).metadata()).width).toBe(320);
    await team.close();
  } finally {
    await withE2eDb(async (q) => {
      await q.exec(
        "DELETE FROM attachments WHERE original_name = 'inline.png' AND post_id = 900105",
      );
      await q.exec("DELETE FROM files WHERE sha256 = ?", [sha]);
    });
    rmSync(path.join(STORAGE, key), { force: true });
  }
});
