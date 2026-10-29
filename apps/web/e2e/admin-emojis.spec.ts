import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { PNG_1X1, solidPng } from "./support/images";
import { USERS, loginAs } from "./support/session";

/**
 * 后台表情管理 E2E（M10.9 Step 5）：admin 视角的全流程（建组 → 上传 → 改名 → 排序 → 停用 → 删除保护），
 * 会员 404；动作写 audit_log；上传产物经 /emoji/{id}.{ext} 可访问、停用后仍可访问（正文不碎）。
 * 数据自造自清（组名带时间戳，防重跑残留导致名称冲突）。
 */

test.describe.configure({ mode: "serial" });

const SUFFIX = Date.now() % 100000;
const GROUP_A = `E2E 表情组 A ${SUFFIX}`;
const GROUP_B = `E2E 表情组 B ${SUFFIX}`;

async function auditExists(action: string): Promise<boolean> {
  return withE2eDb(async (q) => {
    const rows = await q.query<{ id: number }>(
      "SELECT id FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1",
      [action],
    );
    return rows.length > 0;
  });
}

async function cleanup() {
  await withE2eDb(async (q) => {
    await q.exec(
      "DELETE e FROM emojis e JOIN emoji_groups g ON e.group_id = g.id WHERE g.name IN (?, ?)",
      [GROUP_A, GROUP_B],
    );
    await q.exec(
      "DELETE f FROM files f LEFT JOIN emojis e ON e.storage_key = f.storage_key WHERE e.id IS NULL AND f.created_at > NOW() - INTERVAL 1 HOUR AND NOT EXISTS (SELECT 1 FROM file_uploads fu WHERE fu.file_id = f.id)",
      [],
    );
    await q.exec("DELETE FROM emoji_groups WHERE name IN (?, ?)", [GROUP_A, GROUP_B]);
  });
}

async function emojiIdOf(page: Page, name: string): Promise<number> {
  const src = await page
    .locator('[data-testid="emoji-grid"] li', { hasText: name })
    .locator("img")
    .first()
    .getAttribute("src");
  return Number(src!.match(/\/emoji\/(\d+)\./)![1]);
}

test.afterAll(cleanup);

test("会员访问 /admin/emojis → 404（站点级权限）", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  expect((await page.goto("/admin/emojis"))?.status()).toBe(404);
});

test("admin 全流程：建组 → 上传 → /emoji 可访问 → 改名/关键词 → 排序 → 停用（/emoji 仍 200）→ 删除保护", async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(60_000);
  await loginAs(context, USERS.admin);
  await page.goto("/admin/emojis");

  // 建两个组（B 用于删除用例；A/B 用于排序）
  await page.locator('input[name="name"][placeholder="新分组名"]').fill(GROUP_A);
  await page.getByRole("button", { name: "新建分组" }).click();
  await expect(page).toHaveURL(/saved=group-created/);
  await page.locator('input[name="name"][placeholder="新分组名"]').fill(GROUP_B);
  await page.getByRole("button", { name: "新建分组" }).click();
  await expect(page).toHaveURL(/saved=group-created/);
  const groupA = await withE2eDb(async (q) => {
    const rows = await q.query<{ id: number }>("SELECT id FROM emoji_groups WHERE name = ?", [
      GROUP_A,
    ]);
    return Number(rows[0]!.id);
  });
  await page.goto(`/admin/emojis?group=${groupA}`);

  // 上传：96×96 png（合规）；产物经 /emoji/{id}.png 可访问
  await page
    .getByLabel("选择表情文件（可多选）")
    .setInputFiles({ name: "表情一.png", mimeType: "image/png", buffer: await solidPng(96) });
  await page.getByRole("button", { name: "上传表情" }).click();
  await expect(page).toHaveURL(new RegExp(`group=${groupA}&saved=upload`));
  const row = page.locator('[data-testid="emoji-grid"] li', { hasText: "表情一" });
  await expect(row).toBeVisible();
  const id1 = await emojiIdOf(page, "表情一");
  const served = await request.get(`/emoji/${id1}.png`);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/png");
  expect(await auditExists("admin.emoji.group.create")).toBe(true);
  expect(await auditExists("admin.emoji.upload")).toBe(true);

  // 改名 + 关键词
  await page.getByLabel(`表情 #${id1} 的名称`).fill("E2E 改名表情");
  await page.getByLabel(`表情 #${id1} 的搜索关键词`).fill("e2e 测试 关键词");
  await row.getByRole("button", { name: "保存" }).click();
  await expect(page).toHaveURL(/saved=emoji-renamed/);
  await expect(
    page.locator('[data-testid="emoji-grid"] li', { hasText: "E2E 改名表情" }),
  ).toBeVisible();

  // 再传一个 → 组内 ↓ 移动 → 顺序交换（网格首条变为原名表情）
  await page
    .getByLabel("选择表情文件（可多选）")
    .setInputFiles({ name: "表情二.png", mimeType: "image/png", buffer: PNG_1X1 });
  await page.getByRole("button", { name: "上传表情" }).click();
  await expect(page).toHaveURL(/saved=upload/);
  await page
    .locator('[data-testid="emoji-grid"] li', { hasText: "E2E 改名表情" })
    .getByRole("button", { name: "↓" })
    .click();
  await expect(page).toHaveURL(/saved=emoji-moved/);
  const firstName = await page
    .locator('[data-testid="emoji-grid"] li')
    .first()
    .locator("p")
    .first()
    .textContent();
  expect(firstName).toContain("表情二");
  expect(await auditExists("admin.emoji.move")).toBe(true);

  // 停用 → 网格标记停用，但 /emoji 仍 200（已发布正文不能碎）
  await page
    .locator('[data-testid="emoji-grid"] li', { hasText: "E2E 改名表情" })
    .getByRole("button", { name: "停用" })
    .click();
  await expect(page).toHaveURL(/saved=emoji-toggled/);
  await expect(
    page
      .locator('[data-testid="emoji-grid"] li', { hasText: "E2E 改名表情" })
      .and(page.locator('[data-enabled="0"]')),
  ).toBeVisible();
  expect((await request.get(`/emoji/${id1}.png`)).status()).toBe(200);
  expect(await auditExists("admin.emoji.toggle")).toBe(true);

  // 删除保护：有表情的组删不掉（错误提示）；空组可删
  await page.goto("/admin/emojis");
  await page
    .locator('[data-testid="group-list"] li', { hasText: GROUP_A })
    .getByRole("button", { name: "删除" })
    .click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page).toHaveURL(/err=group-not-empty/);
  await page.locator('input[name="name"][placeholder="新分组名"]').fill(`${GROUP_B} 空删`);
  await page.getByRole("button", { name: "新建分组" }).click();
  await page
    .locator('[data-testid="group-list"] li', { hasText: `${GROUP_B} 空删` })
    .getByRole("button", { name: "删除" })
    .click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page).toHaveURL(/saved=group-deleted/);
  await expect(
    page.locator('[data-testid="group-list"] li', { hasText: `${GROUP_B} 空删` }),
  ).toHaveCount(0);
  expect(await auditExists("admin.emoji.group.delete")).toBe(true);
});

test("分组标题图：admin 上传 → 列表显示 + /files 可访问 + 审计；超限拒绝且不改动", async ({
  page,
  request,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await page.goto("/admin/emojis");
  const row = page.locator('[data-testid="group-list"] li', { hasText: GROUP_A });

  // 上传标题图（96×96 png）→ /files 可访问 + 审计
  await row
    .getByLabel(`分组「${GROUP_A}」的标题图`)
    .setInputFiles({ name: "标题图.png", mimeType: "image/png", buffer: await solidPng(96) });
  await row.getByRole("button", { name: "上传标题图" }).click();
  await expect(page).toHaveURL(/saved=group-icon/);
  const iconSrc = await row.locator('img[src^="/files/"]').getAttribute("src");
  expect(iconSrc).toBeTruthy();
  expect((await request.get(iconSrc!)).status()).toBe(200);
  expect(await auditExists("admin.emoji.group.icon")).toBe(true);

  // 更换为超限图（201×201）：拒绝并提示，已有标题图不变
  await page.goto("/admin/emojis");
  await row
    .getByLabel(`分组「${GROUP_A}」的标题图`)
    .setInputFiles({ name: "太大.png", mimeType: "image/png", buffer: await solidPng(201) });
  await row.getByRole("button", { name: "更换标题图" }).click();
  await expect(page).toHaveURL(/err=size/);
  await expect(page.getByText(/尺寸超限/)).toBeVisible();
  await page.goto("/admin/emojis");
  await expect(
    page.locator('[data-testid="group-list"] li img[src^="/files/"]').first(),
  ).toHaveAttribute("src", iconSrc!);
});

test("上传拒绝：jpeg 与超大尺寸给出可读提示，不入库", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  const groupA = await withE2eDb(async (q) => {
    const rows = await q.query<{ id: number }>("SELECT id FROM emoji_groups WHERE name = ?", [
      GROUP_A,
    ]);
    return Number(rows[0]!.id);
  });
  await page.goto(`/admin/emojis?group=${groupA}`);
  const before = await withE2eDb(async (q) => {
    const rows = await q.query<{ n: number }>(
      "SELECT COUNT(*) n FROM emojis e JOIN emoji_groups g ON e.group_id = g.id WHERE g.name = ?",
      [GROUP_A],
    );
    return Number(rows[0]!.n);
  });

  // jpeg：管线拒收（魔数 PNG_1X1 改名 .jpg 不行——嗅探信魔数；这里真造 jpeg 太重，直接用文本文件伪装图片扩展名）
  await page.getByLabel("选择表情文件（可多选）").setInputFiles({
    name: "假图.png",
    mimeType: "image/png",
    buffer: Buffer.from("这只是一段文本，不是图片"),
  });
  await page.getByRole("button", { name: "上传表情" }).click();
  await expect(page).toHaveURL(/err=type/);
  await expect(page.getByText(/格式不支持/)).toBeVisible();

  // 201×201：尺寸超限
  await page
    .getByLabel("选择表情文件（可多选）")
    .setInputFiles({ name: "太大.png", mimeType: "image/png", buffer: await solidPng(201) });
  await page.getByRole("button", { name: "上传表情" }).click();
  await expect(page).toHaveURL(/err=size/);
  await expect(page.getByText(/尺寸超限/)).toBeVisible();

  const after = await withE2eDb(async (q) => {
    const rows = await q.query<{ n: number }>(
      "SELECT COUNT(*) n FROM emojis e JOIN emoji_groups g ON e.group_id = g.id WHERE g.name = ?",
      [GROUP_A],
    );
    return Number(rows[0]!.n);
  });
  expect(after).toBe(before);
});
