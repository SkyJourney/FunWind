import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/** 容量事务与 LOGO 附带失败边界；与其他主题测试共用库，必须沿用全局单 worker。 */
test.describe.configure({ mode: "serial" });
failOnPageErrors();

test.beforeAll(() => {
  expect(test.info().config.workers, "主题全局容量 E2E 必须单 worker 执行").toBe(1);
});

// 共 19 字符，复制动作截取 sourceId 前 19 字符后仍保留完整随机命名空间。
const PREFIX = `e2e-boundary-${randomBytes(3).toString("hex")}`;
const CAPACITY = 5;
const ENABLED_LIMIT_TEXT = "全站最多启用 5 个主题包（含内置包）；请先停用一个，再重试。";
const OWNED_PATTERN = `${PREFIX}-%`;

type SettingSnapshot = { valueJson: string | null; updatedAt: string } | null;
type ThemeRow = { id: string; enabled: number; revision: number; is_builtin: number };

function packId(suffix: string) {
  const id = `${PREFIX}-${suffix}`;
  expect(id.length).toBeLessThanOrEqual(32);
  return id;
}

async function snapshotSetting(key: string): Promise<SettingSnapshot> {
  const [row] = await withE2eDb((q) =>
    q.query<NonNullable<SettingSnapshot>>(
      "SELECT CAST(value AS CHAR) AS valueJson, updated_at AS updatedAt FROM site_settings WHERE `key` = ?",
      [key],
    ),
  );
  return row ?? null;
}

function themeCard(page: Page, id: string) {
  return page
    .locator("div.rounded-xl.border.bg-card")
    .filter({ has: page.locator(`a[href="/admin/themes/${id}"]`) });
}

async function restoreAndDeleteOwned(page: Page, snapshot: SettingSnapshot) {
  let lastOwnedId: string | undefined;
  try {
    await withE2eDb(async (q) => {
      if (snapshot) {
        await q.exec(
          `INSERT INTO site_settings (\`key\`, value, updated_at)
           VALUES ('site.theme', CAST(? AS JSON), ?) AS restored
           ON DUPLICATE KEY UPDATE value = restored.value, updated_at = restored.updated_at`,
          [snapshot.valueJson, snapshot.updatedAt],
        );
      } else {
        await q.exec("DELETE FROM site_settings WHERE `key` = 'site.theme'");
      }
      const owned = await q.query<{ id: string }>(
        "SELECT id FROM theme_packages WHERE id LIKE ? ORDER BY id",
        [OWNED_PATTERN],
      );
      lastOwnedId = owned.at(-1)?.id;
      for (const row of owned.slice(0, -1)) {
        await q.exec("DELETE FROM theme_packages WHERE id = ?", [row.id]);
      }
    });
    if (lastOwnedId) {
      // 最后一个自造包走真实删除动作，失效目录与 chrome 缓存，避免仅 SQL 清理残留 30 秒快照。
      await page.goto("/admin/themes");
      await themeCard(page, lastOwnedId).getByRole("button", { name: "删除", exact: true }).click();
      await page.getByRole("button", { name: "确认", exact: true }).click();
      await expect(page).toHaveURL(/saved=deleted$/);
    }
  } finally {
    // 即使 UI 清理失败，也清除本命名空间内新建、导入及意外复制成功的包，不碰其他测试的数据。
    await withE2eDb((q) => q.exec("DELETE FROM theme_packages WHERE id LIKE ?", [OWNED_PATTERN]));
  }
  expect(await snapshotSetting("site.theme")).toEqual(snapshot);
}

async function enabledCount() {
  const [row] = await withE2eDb((q) =>
    q.query<{ total: number }>("SELECT COUNT(*) AS total FROM theme_packages WHERE enabled = 1"),
  );
  return Number(row?.total ?? 0);
}

async function themeRows(): Promise<ThemeRow[]> {
  // 比较完整记录，不能只断言数量相同而漏掉 revision、配置或资产被改写。
  return withE2eDb((q) => q.query<ThemeRow>("SELECT * FROM theme_packages ORDER BY id"));
}

async function createThroughAdmin(page: Page, id: string, name: string) {
  await page.goto("/admin/themes");
  await page.getByLabel("包 id", { exact: true }).fill(id);
  await page.getByLabel("名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "新建主题包" }).click();
  await expect(page).toHaveURL(new RegExp(`saved=created&id=${id}$`));
}

async function insertDisabledSource(id: string) {
  const result = await withE2eDb((q) =>
    q.exec(
      `INSERT INTO theme_packages
        (id, name, description, schema_version, definition, assets, enabled, is_builtin,
         revision, created_at, updated_at)
       VALUES (?, ?, '', 1, CAST(? AS JSON), JSON_ARRAY(), 0, 0, 1, NOW(), NOW())`,
      [id, "容量边界停用夹具", JSON.stringify({ surfaces: {} })],
    ),
  );
  expect(result.affectedRows).toBe(1);
}

async function expectCapacityRejected(page: Page, before: ThemeRow[]) {
  await expect(page).toHaveURL(/\/admin\/themes\?err=enabled-limit$/);
  await expect(page.getByRole("alert").filter({ hasText: ENABLED_LIMIT_TEXT })).toHaveCount(1);
  await expect(page.getByTestId("theme-pack-capacity")).toHaveText("已启用主题包：5 / 5");
  expect(await themeRows()).toEqual(before);
  expect(await enabledCount()).toBe(CAPACITY);
}

test("满 5 个启用包（含内置）时创建/复制/导入/重新启用均拒绝且完整包记录不变", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const siteTheme = await snapshotSetting("site.theme");
  try {
    await loginAs(context, USERS.admin);
    const initialCount = await enabledCount();
    expect(initialCount, "测试开始时 E2E 库不应已超过容量").toBeLessThanOrEqual(CAPACITY);
    const sourceId = packId("off");
    await insertDisabledSource(sourceId);
    for (let slot = initialCount; slot < CAPACITY; slot += 1) {
      await createThroughAdmin(page, packId(`f${slot}`), `容量边界填充 ${slot}`);
    }
    const before = await themeRows();
    expect(before).toContainEqual(
      expect.objectContaining({ id: "default", enabled: 1, is_builtin: 1 }),
    );

    await page.goto("/admin/themes");
    await expect(page.getByTestId("theme-pack-capacity")).toHaveText("已启用主题包：5 / 5");
    await page.getByLabel("包 id", { exact: true }).fill(packId("new"));
    await page.getByLabel("名称", { exact: true }).fill("容量边界创建拒绝");
    await page.getByRole("button", { name: "新建主题包" }).click();
    await expectCapacityRejected(page, before);

    await page.goto("/admin/themes");
    await themeCard(page, sourceId).getByRole("button", { name: "复制", exact: true }).click();
    await expectCapacityRejected(page, before);

    // 导出自造的无素材包，再经真实导入表单与 route 尝试创建，不绕过容量服务。
    await page.goto("/admin/themes");
    const downloadPromise = page.waitForEvent("download");
    await themeCard(page, sourceId).getByRole("link", { name: "导出 ZIP" }).click();
    const download = await downloadPromise;
    const archivePath = await download.path();
    expect(archivePath).not.toBeNull();
    const importForm = page.getByTestId("theme-package-import");
    await importForm.getByLabel("新包 id").fill(packId("imp"));
    await importForm.getByLabel("主题包 ZIP 文件").setInputFiles({
      name: "boundary-theme.zip",
      mimeType: "application/zip",
      buffer: await readFile(archivePath!),
    });
    await importForm.getByRole("button", { name: "导入主题包" }).click();
    await expectCapacityRejected(page, before);

    await page.goto("/admin/themes");
    await themeCard(page, sourceId).getByRole("button", { name: "启用", exact: true }).click();
    await expectCapacityRejected(page, before);
    expect(await snapshotSetting("site.theme")).toEqual(siteTheme);
  } finally {
    await restoreAndDeleteOwned(page, siteTheme);
  }
});

const entrances = [
  {
    key: "themes",
    path: "/admin/themes",
    saved: "default",
    success: "已设为全站默认主题。",
    // 主题无自带 LOGO（unchanged）：跳转参数与文案不同于联动失败的「保存成功」
    savedNoLogo: "default_no_logo",
    successNoLogo: "已设为全站默认主题（此主题无自带 LOGO，LOGO 保持不变）。",
    warning: "默认主题已保存，但自带 LOGO 未能切换",
  },
  {
    key: "settings",
    path: "/admin/settings",
    saved: "theme",
    success: "全站默认主题已保存并即时生效。",
    savedNoLogo: "theme_no_logo",
    successNoLogo: "全站默认主题已保存（此主题无自带 LOGO，LOGO 保持不变）。",
    warning: "默认主题已成功保存，但自带 LOGO 未能切换",
  },
] as const;

async function selectDefault(page: Page, entrance: (typeof entrances)[number], id: string) {
  await page.goto(entrance.path);
  if (entrance.key === "themes") {
    await themeCard(page, id).getByRole("button", { name: "设为默认", exact: true }).click();
  } else {
    await page.locator(`#theme input[name="pack"][value="${id}"]`).check();
    await page.getByRole("button", { name: "保存默认主题", exact: true }).click();
  }
}

async function expectStoredDefault(id: string) {
  const saved = await snapshotSetting("site.theme");
  expect(saved).not.toBeNull();
  expect(JSON.parse(saved!.valueJson!)).toEqual({ pack: id });
}

for (const entrance of entrances) {
  test(`${entrance.path}：LOGO 引用不在池中仍保存主题并告警，无 LOGO 自定义包成功且无警告`, async ({
    page,
    context,
  }) => {
    const siteTheme = await snapshotSetting("site.theme");
    const logoPool = await snapshotSetting("site.logo");
    const missingPackId = packId(`${entrance.key}-l`);
    const plainPackId = packId(`${entrance.key}-n`);
    const missingLogo = `logo-${randomBytes(16).toString("hex")}.png`;
    try {
      await loginAs(context, USERS.admin);
      expect(logoPool?.valueJson ?? "").not.toContain(missingLogo);
      // 不停用已有包来腾位；现有单 worker、零迁移种子路径可容纳两个自造包。
      expect(
        await enabledCount(),
        "LOGO 用例需要两个空位，请单线程运行并清理其他测试夹具",
      ).toBeLessThanOrEqual(CAPACITY - 2);
      await createThroughAdmin(page, missingPackId, `边界缺失 LOGO · ${entrance.key}`);
      await createThroughAdmin(page, plainPackId, `边界无 LOGO · ${entrance.key}`);
      await withE2eDb((q) =>
        q.exec("UPDATE theme_packages SET assets = CAST(? AS JSON) WHERE id = ?", [
          JSON.stringify([{ kind: "logo", poolFile: missingLogo }]),
          missingPackId,
        ]),
      );

      await selectDefault(page, entrance, missingPackId);
      await expect(page).toHaveURL(`${entrance.path}?saved=${entrance.saved}&warn=logo`);
      await expect(page.getByText(entrance.success, { exact: true })).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: entrance.warning })).toHaveCount(1);
      await expectStoredDefault(missingPackId);
      const [stored] = await withE2eDb((q) =>
        q.query<{ assets: unknown; enabled: number }>(
          "SELECT assets, enabled FROM theme_packages WHERE id = ?",
          [missingPackId],
        ),
      );
      expect(stored?.enabled).toBe(1);
      expect(stored?.assets).toEqual([{ kind: "logo", poolFile: missingLogo }]);
      expect(await snapshotSetting("site.logo")).toEqual(logoPool);

      await selectDefault(page, entrance, plainPackId);
      await expect(page).toHaveURL(`${entrance.path}?saved=${entrance.savedNoLogo}`);
      await expect(page.getByText(entrance.successNoLogo, { exact: true })).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: entrance.warning })).toHaveCount(0);
      await expectStoredDefault(plainPackId);
      expect(await snapshotSetting("site.logo")).toEqual(logoPool);
    } finally {
      await restoreAndDeleteOwned(page, siteTheme);
    }
  });
}
