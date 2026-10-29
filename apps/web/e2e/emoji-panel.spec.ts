import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { bodyEditor, fillBody } from "./support/editor";
import { failOnPageErrors } from "./support/page-errors";
import { PNG_1X1 } from "./support/images";
import { STORAGE_E2E } from "./support/storage";
import { USERS, loginAs } from "./support/session";

/**
 * 编辑器面板接入社区表情（M10.9 Step 6，dev 服务器）：
 *   · 零数据站点：面板只有 Unicode 页签，功能不受影响；
 *   · 有数据：「社区表情」页签按分组小标题平铺，停用的表情不出现；搜索同时命中 Unicode 与社区表情；
 *   · 点击插入行内图片节点（alt=展示名），发布后帖子页以 /emoji/{id}.{ext} 渲染；文档合法、页面无异常。
 * 表情数据自造自清（emoji-serving / admin-emojis 两案都自清，这里先清全部再自造，顺序无关）。
 */

test.describe.configure({ mode: "serial" });
failOnPageErrors();

const SUFFIX = Date.now() % 100000;
const GROUP_A = `E2E 面板组 A ${SUFFIX}`;
const GROUP_B = `E2E 面板组 B ${SUFFIX}`;

let emojiEnabled = 0;
let emojiDisabled = 0;

/** 打开发帖页的表情面板（默认编辑器为所见即所得） */
async function openEmojiPanel(page: Page) {
  await page.goto("/f/954/new");
  await page.locator("#thread-title").fill(`E2E 社区表情面板 ${SUFFIX}`);
  await fillBody(page, "面板用例正文");
  await page.getByRole("button", { name: "表情" }).click();
  await page.getByLabel("搜索表情").waitFor();
}

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    // 零数据起点：面板用例对库内表情有全局断言，清掉其它用例可能残留的行（它们都自清，这里是保险）
    await q.exec("DELETE FROM emojis");
    await q.exec("DELETE FROM emoji_groups");
  });
});

test.afterAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM emojis WHERE id IN (?, ?)", [emojiEnabled, emojiDisabled]);
    await q.exec("DELETE FROM emoji_groups WHERE name IN (?, ?)", [GROUP_A, GROUP_B]);
  });
});

test("零数据：面板只有 Unicode 页签；/api/emojis 返回空", async ({ page, request }) => {
  await loginAs(page.context(), USERS.member);
  const api = await request.get("/api/emojis");
  expect(api.status()).toBe(200);
  expect(await api.json()).toEqual([]);

  await openEmojiPanel(page);
  await expect(page.getByRole("tab", { name: "社区表情" })).toHaveCount(0);
  expect(page.getByRole("tab", { name: "笑脸与情绪" })).toBeVisible();
});

test("有数据：社区页签分组平铺（带标题图）、停用不出现、合并搜索、插入行内图片并发布渲染", async ({
  page,
  request,
}) => {
  await loginAs(page.context(), USERS.member);
  // A 组的标题图：自造 PNG 写进 E2E 存储目录 + files 行，icon_key 指向它（/files 公开出口）
  const iconBytes = PNG_1X1;
  const iconSha = createHash("sha256").update(iconBytes).digest("hex");
  const iconKey = `${iconSha.slice(0, 2)}/${iconSha.slice(2, 4)}/${iconSha}.png`;
  mkdirSync(join(STORAGE_E2E, iconSha.slice(0, 2), iconSha.slice(2, 4)), { recursive: true });
  writeFileSync(join(STORAGE_E2E, iconKey), iconBytes);
  await withE2eDb(async (q) => {
    await q.exec(
      "INSERT IGNORE INTO files (sha256, storage_key, size_bytes, mime, width, height, created_at) VALUES (?, ?, ?, 'image/png', 1, 1, NOW())",
      [iconSha, iconKey, iconBytes.byteLength],
    );
    const a = await q.exec(
      "INSERT INTO emoji_groups (name, sort, enabled, icon_key, created_at, updated_at) VALUES (?, 0, 1, ?, NOW(), NOW())",
      [GROUP_A, iconKey],
    );
    const b = await q.exec(
      "INSERT INTO emoji_groups (name, sort, enabled, created_at, updated_at) VALUES (?, 1, 1, NOW(), NOW())",
      [GROUP_B],
    );
    // 启用表情（A 组，有搜索关键词）；停用表情（B 组）不应出现在面板
    emojiEnabled = (
      await q.exec(
        "INSERT INTO emojis (group_id, name, keywords, ext, storage_key, sort, enabled, created_at, updated_at) VALUES (?, 'E2E 茉莉笑', '茉莉 e2e面板', 'png', NULL, 1, 1, NOW(), NOW())",
        [a.insertId],
      )
    ).insertId;
    emojiDisabled = (
      await q.exec(
        "INSERT INTO emojis (group_id, name, keywords, ext, storage_key, sort, enabled, created_at, updated_at) VALUES (?, 'E2E 停用表情', '', 'gif', NULL, 1, 0, NOW(), NOW())",
        [b.insertId],
      )
    ).insertId;
  });

  // API：启用者带分组与 URL、组带标题图；停用者不出现
  const api = await request.get("/api/emojis");
  const list = (await api.json()) as {
    id: number;
    name: string;
    url: string;
    group: string;
    groupIcon: string | null;
  }[];
  const enabled = list.find((x) => x.id === emojiEnabled);
  expect(enabled, JSON.stringify(list)).toBeTruthy();
  expect(enabled!.url).toBe(`/emoji/${emojiEnabled}.png`);
  expect(enabled!.group).toBe(GROUP_A);
  expect(enabled!.groupIcon).toBe(`/files/${iconKey}`);
  expect(list.find((x) => x.id === emojiDisabled)).toBeUndefined();
  // 标题图经 /files 公开出口可访问
  expect((await request.get(`/files/${iconKey}`)).status()).toBe(200);
  // ETag 304
  const again = await request.get("/api/emojis", {
    headers: { "if-none-match": api.headers()["etag"]! },
  });
  expect(again.status()).toBe(304);

  // 面板：社区页签 + 分组小标题（A 组标题带标题图）；停用者不可见
  await openEmojiPanel(page);
  await page.getByRole("tab", { name: "社区表情" }).click();
  const groupASection = page.getByRole("grid", { name: GROUP_A });
  await expect(groupASection).toBeVisible();
  await expect(
    page.locator(`p:has(+ [role="grid"][aria-label="${GROUP_A}"]) img[src="/files/${iconKey}"]`),
  ).toBeVisible();
  await expect(page.getByRole("gridcell", { name: "E2E 茉莉笑" })).toBeVisible();
  await expect(page.getByRole("gridcell", { name: "E2E 停用表情" })).toHaveCount(0);

  // 合并搜索：关键词「茉莉」同时命中社区表情（Unicode 侧不保证有命中，这里断言社区段出现即可）
  await page.getByLabel("搜索表情").fill("茉莉 e2e面板");
  await expect(page.getByRole("grid", { name: "社区表情" })).toBeVisible();
  await expect(page.getByRole("gridcell", { name: "E2E 茉莉笑" })).toBeVisible();

  // 点击插入（默认关闭面板）→ 富文本出现行内图片节点
  await page.getByRole("gridcell", { name: "E2E 茉莉笑" }).first().click();
  await expect(page.getByRole("button", { name: "表情" })).toBeVisible(); // 面板已关
  await expect(bodyEditor(page).locator('img[alt="E2E 茉莉笑"]')).toHaveCount(1);

  // 发布 → 帖子页以 /emoji/{id}.png 渲染（alt 保留展示名）
  await page.getByRole("button", { name: "发布主题" }).click();
  await expect(page).toHaveURL(/\/t\/\d+$/);
  const img = page.locator(`.content-md img[src="/emoji/${emojiEnabled}.png"]`);
  await expect(img).toBeVisible();
  expect(await img.getAttribute("alt")).toBe("E2E 茉莉笑");
});
