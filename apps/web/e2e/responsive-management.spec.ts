import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import sharp from "sharp";
import { hydrated } from "./support/hydration";
import { LayoutAudit, LAYOUT_AUDIT_ONLY } from "./support/layout-audit";
import { failOnPageErrors } from "./support/page-errors";
import {
  LAYOUT_WIDTHS,
  LONG_ASCII,
  LONG_FILE_NAME,
  LONG_INVALID_NAME,
  LONG_PNG_NAME,
  ResponsiveFixtures,
  type BrandPoolKind,
  type BrandPoolState,
  type LayoutThread,
} from "./support/responsive-fixtures";
import { USERS, loginAs } from "./support/session";

/**
 * 已有生产项目内自行切六档视口，不借 mobile/production-only 项目重复跑。
 * 基线：LAYOUT_AUDIT_ONLY=1 逐场景收集失败而不中断，默认严格断言。
 * 截图：仅 RUN_LAYOUT_SCREENSHOTS=1 导出；路径和全部几何写入 layout-audit.json。
 * 本文件不走重置脚本，不修改生产组件/配置，不依赖真实迁移数据。
 */
test.use({ screenshot: "off", trace: "off", video: "off" });
// 审查模式把页面异常写进 LayoutAudit JSON；严格模式仍启用项目通用未捕获异常护栏。
if (!LAYOUT_AUDIT_ONLY) failOnPageErrors();
test.beforeAll(() => {
  expect(test.info().config.workers, "响应式布局测试依赖全局单 worker 和各自随机标记").toBe(1);
});
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "production", "跨尺寸场景仅属于 production 项目");
});

const ADMIN_ROOT = ".lg\\:pl-56 > div";
const ADMIN_BUTTONS = `${ADMIN_ROOT} button, ${ADMIN_ROOT} a[href][class~="border"]`;
const THREAD_BUTTONS = 'main [id^="p"] button, main [id^="p"] a[href^="/p/"]';
const LONG_REASON = "布局回归理由：" + "需保持输入区域与操作控件完整可见。".repeat(8);

/** 等待真实服务器动作返回，不把原本已满足的同 URL 当作提交完成。 */
async function submit(page: Page, button: Locator): Promise<void> {
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && Boolean(r.request().headers()["next-action"]),
  );
  await button.click();
  await response;
}

/** 只检查显示与布局，不提交审核/封禁等动作，避免奖励、通知、共享缓存计数被改动。 */
async function expectActions(
  page: Page,
  postId: number,
  state: "visible" | "pending",
  moderate: boolean,
): Promise<void> {
  const card = page.locator(`#p${postId}`);
  await expect(card).toBeVisible();
  await expect(card.getByRole("link", { name: "编辑", exact: true })).toHaveCount(moderate ? 1 : 0);
  for (const action of ["删除", "屏蔽"] as const) {
    const count = moderate && (action === "删除" || state === "visible") ? 1 : 0;
    await expect(card.getByRole("link", { name: action, exact: true })).toHaveCount(count);
  }
  await expect(card.getByRole("button", { name: "通过", exact: true })).toHaveCount(
    moderate && state === "pending" ? 1 : 0,
  );
  await expect(card.getByRole("button", { name: "驳回", exact: true })).toHaveCount(
    moderate && state === "pending" ? 1 : 0,
  );
  await expect(card.getByRole("button", { name: "封禁", exact: true })).toHaveCount(
    moderate ? 1 : 0,
  );
  if (moderate) {
    await card.getByRole("textbox", { name: "封禁理由（作者可见）" }).fill(LONG_REASON);
    if (state === "pending")
      await card.getByRole("textbox", { name: "驳回理由", exact: true }).fill(LONG_REASON);
  }
}

/** 动作区另存真实视口截图，先居中滚入视口，避免长卡片截图与底部悬浮按钮的合成伪影。 */
async function capturePostActionsViewport(
  page: Page,
  info: TestInfo,
  label: string,
  selector: string,
): Promise<void> {
  if (process.env.RUN_LAYOUT_SCREENSHOTS !== "1") return;
  const actions = page.locator(selector);
  await actions.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
  );
  await expect(actions).toBeInViewport({ ratio: 1 });
  const screenshot = info.outputPath("responsive", `${label}-post-actions-viewport.png`);
  await mkdir(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: false, animations: "disabled" });
  await info.attach(`${label}-post-actions-viewport`, {
    path: screenshot,
    contentType: "image/png",
  });
}

/** 重点场景逐个独立采集；卡片截图保留可见首帖/回复动作，避免长页缩略图掩盖局部问题。 */
async function auditThread(
  audit: LayoutAudit,
  page: Page,
  label: string,
  thread: LayoutThread,
  pending: boolean,
  moderate: boolean,
  actionScreenshotInfo?: TestInfo,
): Promise<void> {
  await audit.step(label, async () => {
    const response = await page.goto(`/t/${thread.id}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: thread.title })).toBeVisible();
    await expectActions(page, thread.first, pending ? "pending" : "visible", moderate);
    await expectActions(page, thread.reply, "visible", moderate);
    if (moderate) await expectActions(page, thread.pendingReply, "pending", true);
    else await expect(page.locator(`#p${thread.pendingReply}`)).toHaveCount(0);
    await expect(page.locator(`#p${thread.first} .content-md`)).toContainText(LONG_ASCII);
    await expect(page.locator(`#p${thread.first}`)).toContainText(LONG_FILE_NAME);
    const actionSelector = `#p${thread.first} [data-post-actions]`;
    // 冻结构建还没有此标记；只为新构建追加动作区证据，不把旧基线的缺标记当布局失败。
    const captureActions =
      Boolean(actionScreenshotInfo) && (await page.locator(actionSelector).count()) > 0;
    await audit.capture(label, {
      roots: 'main [data-slot="card"]',
      buttons: THREAD_BUTTONS,
      required: [`#p${thread.first}`, `#p${thread.reply}`],
      regions: [
        { name: "first", selector: `#p${thread.first}` },
        { name: "reply", selector: `#p${thread.reply}` },
        ...(moderate ? [{ name: "pending-reply", selector: `#p${thread.pendingReply}` }] : []),
        ...(captureActions ? [{ name: "post-actions", selector: actionSelector }] : []),
      ],
    });
    if (captureActions && actionScreenshotInfo)
      await capturePostActionsViewport(page, actionScreenshotInfo, label, actionSelector);
  });
}

/** 弹窗只打开/取消，不做有副作用的写操作；与后台上传控件同样检查单行动作与边界。 */
async function auditHideDialog(
  audit: LayoutAudit,
  page: Page,
  label: string,
  thread: LayoutThread,
): Promise<void> {
  await audit.step(label, async () => {
    await page.goto(`/t/${thread.id}`);
    await page
      .locator(`#p${thread.first}`)
      .getByRole("link", { name: "屏蔽", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "理由（必填）" }).fill(LONG_REASON);
    await audit.capture(label, {
      roots: '[role="dialog"]',
      buttons: '[role="dialog"] button',
      required: ['[role="dialog"]'],
      regions: [{ name: "dialog", selector: '[role="dialog"]' }],
    });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
}

/** 只用服务端生成的安全文件名定位自有池卡片，不依赖种子池为空。 */
function brandCard(page: Page, file: string): Locator {
  return page.locator(`[data-slot="card"]:has(input[name="file"][value="${file}"])`);
}

/** 真实确认移除会失效 chrome 缓存；同 URL 返回后还须等待卡片消失，不能只等导航。 */
async function removeBrandItem(page: Page, kind: BrandPoolKind, file: string): Promise<void> {
  await page.goto(`/admin/${kind}`);
  const card = brandCard(page, file);
  await card.getByRole("button", { name: "移除", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await submit(page, dialog.getByRole("button", { name: "确认", exact: true }));
  await expect(card).toHaveCount(0);
}

/** 仅当收尾时 active 仍属本场景才恢复旧选择；别人改选的当前项绝不被快照覆盖。 */
async function cleanupBrandPool(
  page: Page,
  fixture: ResponsiveFixtures,
  kind: BrandPoolKind,
  before: BrandPoolState,
): Promise<void> {
  try {
    const pool = await fixture.trackBrandPoolFiles(kind);
    const names = fixture.brandAssetNames(kind);
    const owned = pool.items.filter((item) => names.includes(item.name));
    const activeWasOwned = owned.some((item) => item.file === pool.active);
    // 非当前项先移除，当前项最后移除并自然回退，不额外修改全局主题设置。
    owned.sort((a, b) => Number(a.file === pool.active) - Number(b.file === pool.active));
    for (const item of owned) await removeBrandItem(page, kind, item.file);
    const removed = await fixture.readBrandPool(kind);
    let expectedActive = removed.active;
    if (
      activeWasOwned &&
      removed.active === null &&
      before.active &&
      removed.items.some((item) => item.file === before.active)
    ) {
      await page.goto(`/admin/${kind}`);
      // 在真实设当前提交前再次核对；收尾过程中出现他人的选择就保留它。
      if ((await fixture.readBrandPool(kind)).active === null) {
        await submit(
          page,
          brandCard(page, before.active).getByRole("button", { name: "设为当前", exact: true }),
        );
        expectedActive = before.active;
      } else expectedActive = (await fixture.readBrandPool(kind)).active;
    }
    const after = await fixture.readBrandPool(kind);
    expect(after.items.filter((item) => names.includes(item.name))).toEqual([]);
    expect(after.active, `${kind} 清理应恢复旧选择或保留他人的新选择`).toBe(expectedActive);
  } finally {
    // 品牌移除只注销池项、保留磁盘；确认注销后再精确删除自己的文件，不碰 files 附件表。
    await fixture.cleanupBrandFiles(kind);
  }
}

/** 两次合法上传产生自然网格卡片；非当前项必须同时有设当前和移除，不制造主题包。 */
async function auditNonemptyBrandPool(
  audit: LayoutAudit,
  page: Page,
  fixture: ResponsiveFixtures,
  kind: BrandPoolKind,
  png: Buffer,
): Promise<void> {
  const before = await fixture.readBrandPool(kind);
  try {
    await audit.step(`admin-${kind}-nonempty-pool-cards`, async () => {
      const names = fixture.brandAssetNames(kind);
      for (const name of names) {
        expect(name).toMatch(/^[A-Za-z0-9]{40}$/);
        await page.goto(`/admin/${kind}`);
        await page.getByLabel("名称", { exact: true }).fill(name);
        await page.getByLabel(/PNG 文件/).setInputFiles({
          name: `${kind}.png`,
          mimeType: "image/png",
          buffer: png,
        });
        await submit(page, page.getByRole("button", { name: "上传入池", exact: true }));
        await expect(page).toHaveURL(new RegExp(`/admin/${kind}\\?added=${kind}-[a-z0-9]+\\.png$`));
        await fixture.trackBrandPoolFiles(kind);
      }
      const pool = await fixture.readBrandPool(kind);
      const first = pool.items.find((item) => item.name === names[0])!;
      const second = pool.items.find((item) => item.name === names[1])!;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(pool.active).toBe(second.file);
      const card = brandCard(page, first.file);
      await expect(card.getByRole("button", { name: "设为当前", exact: true })).toBeVisible();
      await expect(card.getByRole("button", { name: "移除", exact: true })).toBeVisible();
      await expect
        .poll(() => card.locator("img").evaluate((node) => (node as HTMLImageElement).naturalWidth))
        .toBe(96);
      await audit.capture(`admin-${kind}-nonempty-pool-cards`, {
        roots: ADMIN_ROOT,
        buttons: ADMIN_BUTTONS,
        required: [
          `[data-slot="card"]:has(input[name="file"][value="${first.file}"])`,
          `[data-slot="card"]:has(input[name="file"][value="${second.file}"])`,
        ],
        regions: [
          {
            name: "pool-grid",
            selector: `div.grid:has(> [data-slot="card"] img[alt="${names[0]}"])`,
          },
          { name: "pool-card", selector: `[data-slot="card"]:has(img[alt="${names[0]}"])` },
          { name: "active-pool-card", selector: `[data-slot="card"]:has(img[alt="${names[1]}"])` },
        ],
      });
      await submit(page, card.getByRole("button", { name: "设为当前", exact: true }));
      await expect(card.getByText("当前生效中", { exact: true })).toBeVisible();
      expect((await fixture.readBrandPool(kind)).active).toBe(first.file);
    });
  } finally {
    await cleanupBrandPool(page, fixture, kind, before);
  }
}

/** 审核队列与内容管理都以真实夹具行定位，版主仍只检查 904，不授予额外作用域。 */
async function auditManagementQueues(
  audit: LayoutAudit,
  page: Page,
  fixture: ResponsiveFixtures,
  role: "admin" | "mod",
  width: number,
): Promise<void> {
  const teamPending = fixture.threads.teamPending!;
  const publicPending = fixture.threads.publicPending!;
  await audit.step(`${role}-review-pending-queue`, async () => {
    await page.goto("/admin/review?forum=904&kind=thread");
    const row = page.locator(`li:has(input[name="postIds"][value="${teamPending.first}"])`);
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "通过", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "驳回", exact: true })).toBeVisible();
    await row.getByRole("checkbox").check();
    await row.locator('input[name="reason"]').fill(LONG_REASON);
    await page.locator('#bulk-review-form input[name="reason"]').fill(LONG_REASON);
    await audit.capture(`${role}-review-pending-queue`, {
      roots: ADMIN_ROOT,
      buttons: ADMIN_BUTTONS,
      required: ["#bulk-review-form", `input[name="postIds"][value="${teamPending.first}"]`],
      regions: [
        {
          name: "review-row",
          selector: `li:has(input[name="postIds"][value="${teamPending.first}"])`,
        },
        { name: "review-bulk-actions", selector: "#bulk-review-form" },
      ],
    });
  });
  await audit.step(`${role}-review-reply-queue`, async () => {
    await page.goto("/admin/review?forum=904&kind=reply");
    const row = page.locator(`li:has(input[name="postIds"][value="${teamPending.pendingReply}"])`);
    await expect(row).toBeVisible();
    await row.locator('input[name="reason"]').fill(LONG_REASON);
    await audit.capture(`${role}-review-reply-queue`, {
      roots: ADMIN_ROOT,
      buttons: ADMIN_BUTTONS,
      required: [`input[name="postIds"][value="${teamPending.pendingReply}"]`],
      regions: [
        {
          name: "review-reply",
          selector: `li:has(input[name="postIds"][value="${teamPending.pendingReply}"])`,
        },
      ],
    });
  });
  for (const kind of ["thread", "reply"] as const) {
    await audit.step(`${role}-contents-${kind}-management`, async () => {
      await page.goto(`/admin/contents?kind=${kind}&q=${encodeURIComponent(fixture.marker)}`);
      const expectedPost = kind === "thread" ? teamPending.first : teamPending.pendingReply;
      await expect(
        page.locator(`li input[name="postId"][value="${expectedPost}"]`).first(),
      ).toBeAttached();
      if (role === "mod") {
        await expect(page.locator(`${ADMIN_ROOT} a[href="/t/${publicPending.id}"]`)).toHaveCount(0);
      } else
        await expect(
          page.locator(`${ADMIN_ROOT} a[href="/t/${publicPending.id}"]`).first(),
        ).toBeVisible();
      for (const input of await page.locator(`${ADMIN_ROOT} li input[name="reason"]`).all())
        await input.fill(LONG_REASON);
      await expect(page.getByRole("button", { name: "通过", exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "驳回", exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "屏蔽", exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "封禁", exact: true }).first()).toBeVisible();
      await audit.capture(`${role}-contents-${kind}-management`, {
        roots: ADMIN_ROOT,
        buttons: ADMIN_BUTTONS,
        required: [`${ADMIN_ROOT} li:has(input[name="postId"][value="${expectedPost}"])`],
        regions: [
          {
            name: "content-row",
            selector: `li:has(input[name="postId"][value="${expectedPost}"])`,
          },
        ],
      });
    });
  }
  if (role === "mod") {
    for (const route of ["review", "contents"] as const) {
      await audit.step(`mod-${route}-outside-scope-empty`, async () => {
        await page.goto(
          `/admin/${route}?forum=954&kind=thread${route === "contents" ? `&q=${encodeURIComponent(fixture.marker)}` : ""}`,
        );
        await expect(page.locator(`${ADMIN_ROOT} a[href="/t/${publicPending.id}"]`)).toHaveCount(0);
        await expect(
          page.locator(
            `${ADMIN_ROOT} li input[name="postId"], ${ADMIN_ROOT} li input[name="postIds"]`,
          ),
        ).toHaveCount(0);
        await audit.capture(`mod-${route}-outside-scope-empty`, {
          roots: ADMIN_ROOT,
          buttons: ADMIN_BUTTONS,
        });
      });
    }
  }
  if (width < 1024) {
    await audit.step(`${role}-admin-drawer-open`, async () => {
      await page.goto("/admin/review?forum=904&kind=thread");
      await page.getByRole("button", { name: "后台菜单", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "后台导航", exact: true });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("link", { name: "内容审核", exact: true })).toBeVisible();
      await expect(drawer.getByRole("link", { name: "内容管理", exact: true })).toBeVisible();
      await expect(drawer.getByRole("link", { name: "主题管理", exact: true })).toHaveCount(
        role === "admin" ? 1 : 0,
      );
      await audit.capture(`${role}-admin-drawer-open`, {
        roots: '[data-slot="sheet-content"]',
        buttons: '[data-slot="sheet-content"] button, [data-slot="sheet-content"] a[href]',
        required: ['[data-slot="sheet-content"]'],
        regions: [{ name: "drawer", selector: '[data-slot="sheet-content"]' }],
      });
      await drawer.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(drawer).toHaveCount(0);
    });
  }
}

for (const width of LAYOUT_WIDTHS) {
  test.describe(`响应式管理 ${width}px`, () => {
    test(`前台权限、长正文附件及后台工作区 @layout-${width}`, async ({ page, context }, info) => {
      test.setTimeout(300_000);
      page.setDefaultTimeout(8_000);
      page.setDefaultNavigationTimeout(20_000);
      await page.setViewportSize({ width, height: 900 });
      const audit = new LayoutAudit(page, info);
      const fixture = new ResponsiveFixtures();
      const signIn = async (user: number | null) => {
        await context.clearCookies();
        if (user !== null) fixture.trackSession(await loginAs(context, user));
      };
      try {
        await fixture.seed();
        const teamVisible = fixture.threads.teamVisible!;
        const teamPending = fixture.threads.teamPending!;
        const publicVisible = fixture.threads.publicVisible!;
        const publicPending = fixture.threads.publicPending!;

        await signIn(USERS.admin);
        await auditThread(audit, page, "admin-904-visible", teamVisible, false, true, info);
        await auditThread(audit, page, "admin-904-pending-first", teamPending, true, true);
        await auditThread(audit, page, "admin-public-visible", publicVisible, false, true);
        await auditThread(audit, page, "admin-public-pending-first", publicPending, true, true);
        await auditHideDialog(audit, page, "admin-hide-dialog", publicVisible);
        await auditManagementQueues(audit, page, fixture, "admin", width);

        await signIn(USERS.team);
        await auditThread(audit, page, "mod-904-visible", teamVisible, false, true);
        await auditThread(audit, page, "mod-904-pending-first", teamPending, true, true);
        await auditHideDialog(audit, page, "mod-hide-dialog", teamVisible);
        await auditManagementQueues(audit, page, fixture, "mod", width);
        await auditThread(
          audit,
          page,
          "mod-outside-904-no-management",
          publicVisible,
          false,
          false,
        );
        await audit.step("mod-outside-904-pending-404", async () => {
          expect((await page.goto(`/t/${publicPending.id}`))?.status()).toBe(404);
          await expect(page.getByText(LONG_ASCII, { exact: true })).toHaveCount(0);
          await audit.capture("mod-outside-904-pending-404");
        });

        // 成员与游客既不能看到待审内容，也不能在公开内容上获得管理动作。
        for (const [role, user] of [
          ["member", USERS.member],
          ["guest", null],
        ] as const) {
          await signIn(user);
          await auditThread(
            audit,
            page,
            `${role}-public-no-management`,
            publicVisible,
            false,
            false,
          );
          await audit.step(`${role}-no-privilege-escalation`, async () => {
            const attachment = page
              .locator(`#p${publicVisible.first}`)
              .locator('a[href^="/files/"]');
            if (user === null) {
              await expect(attachment).toHaveCount(0);
              await expect(page.locator(`#p${publicVisible.first}`)).toContainText("登录后下载");
            } else await expect(attachment).toHaveCount(1);
            for (const thread of [teamVisible, teamPending, publicPending]) {
              expect((await page.goto(`/t/${thread.id}`))?.status(), thread.title).toBe(404);
              await expect(page.getByText(LONG_ASCII, { exact: true })).toHaveCount(0);
            }
            await audit.capture(`${role}-pending-and-restricted-404`);
          });
        }

        // 所有后台越权入口都检查，不把菜单隐藏等同于页面已鉴权。
        const adminPaths = [
          "/admin/logo",
          "/admin/hero",
          "/admin/decor",
          "/admin/emojis",
          `/admin/forums/${fixture.forumId}`,
          `/admin/authz/${fixture.roleKey}`,
          "/admin/themes/default",
        ];
        for (const [role, user] of [
          ["mod", USERS.team],
          ["member", USERS.member],
          ["guest", null],
        ] as const) {
          await signIn(user);
          for (const adminPath of adminPaths) {
            await audit.step(`${role}-denied-${adminPath}`, async () => {
              const response = await page.goto(adminPath);
              if (user === null) await expect(page).toHaveURL(/\/login(?:\?|$)/);
              else expect(response?.status()).toBe(404);
              await expect(page.locator('input[type="file"]')).toHaveCount(0);
              await expect(page.locator('input[name="permissionKey"]')).toHaveCount(0);
            });
          }
        }

        await signIn(USERS.admin);
        const png = await sharp(randomBytes(96 * 96 * 3), {
          raw: { width: 96, height: 96, channels: 3 },
        })
          .png()
          .toBuffer();
        for (const [kind, heading] of [
          ["logo", "LOGO 管理"],
          ["hero", "首页横幅"],
          ["decor", "主题素材"],
        ] as const) {
          await audit.step(`admin-${kind}-before-selection`, async () => {
            await page.goto(`/admin/${kind}`);
            await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
            await audit.capture(`admin-${kind}-before-selection`, {
              roots: ADMIN_ROOT,
              buttons: ADMIN_BUTTONS,
              required: ['input[type="file"][name="file"]'],
            });
          });
          await audit.step(`admin-${kind}-long-selected-filename`, async () => {
            const label = page.locator(`${ADMIN_ROOT} label:has(input[type="file"][name="file"])`);
            const input = label.locator('input[type="file"][name="file"]');
            await input.setInputFiles({ name: LONG_PNG_NAME, mimeType: "image/png", buffer: png });
            await expect(input).toHaveAttribute("aria-invalid", "false");
            await expect(label).toContainText("已选");
            await expect(label).toContainText(LONG_PNG_NAME);
            await audit.capture(`admin-${kind}-long-selected-filename`, {
              roots: ADMIN_ROOT,
              buttons: ADMIN_BUTTONS,
              regions: [
                { name: "upload-card", selector: '[data-slot="card"]:has(input[name="file"])' },
              ],
            });
          });
          await audit.step(`admin-${kind}-non-png-client-error`, async () => {
            const label = page.locator(`${ADMIN_ROOT} label:has(input[type="file"][name="file"])`);
            const input = label.locator('input[type="file"][name="file"]');
            await input.setInputFiles({
              name: LONG_INVALID_NAME,
              mimeType: "image/jpeg",
              buffer: Buffer.from("这不是 PNG"),
            });
            await expect(input).toHaveAttribute("aria-invalid", "true");
            await expect(input).toHaveValue("");
            const error = label.getByRole("alert");
            await expect(error).toContainText(LONG_INVALID_NAME);
            await expect(error).toContainText("不是 PNG");
            await audit.capture(`admin-${kind}-non-png-client-error`, {
              roots: ADMIN_ROOT,
              buttons: ADMIN_BUTTONS,
              regions: [
                { name: "upload-card", selector: '[data-slot="card"]:has(input[name="file"])' },
              ],
            });
          });
          await audit.step(`admin-${kind}-non-png-server-error`, async () => {
            // MIME 伪装为 PNG 通过客户端初筛，真实字节在合法上传 Action 中被魔数校验拒绝。
            await page.getByLabel(/PNG 文件/).setInputFiles({
              name: LONG_PNG_NAME,
              mimeType: "image/png",
              buffer: Buffer.from("E2E 非 PNG 魔数"),
            });
            await submit(page, page.getByRole("button", { name: "上传入池", exact: true }));
            await expect(page).toHaveURL(new RegExp(`/admin/${kind}\\?err=bad_type$`));
            const flash = page
              .locator(`${ADMIN_ROOT} p[role='alert'], ${ADMIN_ROOT} p[role='status']`)
              .filter({ hasText: "仅支持 PNG" });
            await expect(flash).toBeVisible();
            await audit.capture(`admin-${kind}-non-png-server-error`, {
              roots: ADMIN_ROOT,
              buttons: ADMIN_BUTTONS,
              required: [`${ADMIN_ROOT} p[role='alert'], ${ADMIN_ROOT} p[role='status']`],
            });
          });
          await auditNonemptyBrandPool(audit, page, fixture, kind, png);
        }

        await audit.step("admin-emojis-before-batch-selection", async () => {
          await page.goto(`/admin/emojis?group=${fixture.emojiGroupId}`);
          await expect(page.getByLabel("选择表情文件（可多选）")).toBeVisible();
          await expect(page.getByTestId("emoji-grid").locator("tbody tr")).toHaveCount(1);
          await audit.capture("admin-emojis-before-batch-selection", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: ['input[name="files"]', '[data-testid="emoji-grid"]'],
          });
        });
        await audit.step("admin-emojis-long-batch-selection", async () => {
          const input = page.getByLabel("选择表情文件（可多选）");
          await input.setInputFiles(
            [1, 2, 3, 4].map((index) => ({
              name: `${index}-${LONG_PNG_NAME}`,
              mimeType: "image/png",
              buffer: png,
            })),
          );
          expect(await input.evaluate((node) => (node as HTMLInputElement).files?.length)).toBe(4);
          await audit.capture("admin-emojis-long-batch-selection", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            regions: [{ name: "batch-upload", selector: 'form:has(input[name="files"])' }],
          });
          await input.setInputFiles([]);
        });

        await audit.step("admin-forum-icon-before-selection", async () => {
          await page.goto(`/admin/forums/${fixture.forumId}`);
          await expect(page.getByText("板块图", { exact: true })).toBeVisible();
          await audit.capture("admin-forum-icon-before-selection", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: ['input[name="icon"]'],
          });
        });
        await audit.step("admin-forum-icon-long-selected-filename", async () => {
          const input = page.getByLabel("板块图文件（PNG/JPG/WebP，≤512×512、≤300KB）");
          await input.setInputFiles({ name: LONG_PNG_NAME, mimeType: "image/png", buffer: png });
          expect(await input.evaluate((node) => (node as HTMLInputElement).files?.[0]?.name)).toBe(
            LONG_PNG_NAME,
          );
          await audit.capture("admin-forum-icon-long-selected-filename", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            regions: [
              { name: "icon-card", selector: '[data-slot="card"]:has(input[name="icon"])' },
            ],
          });
          await submit(
            page,
            page
              .locator('form:has(input[name="icon"])')
              .getByRole("button", { name: "上传", exact: true }),
          );
          await expect(page).toHaveURL(/iconSaved=1/);
          const icon = page.locator('[data-slot="card"] img[src^="/files/"]').first();
          const src = await icon.getAttribute("src");
          expect(src).toMatch(/^\/files\//);
          await fixture.trackUploadedStorageKey(src!.slice("/files/".length));
          await expect
            .poll(() => icon.evaluate((node) => (node as HTMLImageElement).naturalWidth))
            .toBeGreaterThan(0);
          await audit.capture("admin-forum-icon-uploaded", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: ['img[src^="/files/"]'],
          });
        });
        await audit.step("admin-forum-icon-invalid-error", async () => {
          await page.getByLabel("板块图文件（PNG/JPG/WebP，≤512×512、≤300KB）").setInputFiles({
            name: LONG_PNG_NAME,
            mimeType: "image/png",
            buffer: Buffer.from("不是板块图片"),
          });
          await submit(
            page,
            page
              .locator('form:has(input[name="icon"])')
              .getByRole("button", { name: /上传|更换/, exact: true }),
          );
          await expect(page).toHaveURL(/iconErr=/);
          await expect(
            page.locator(`${ADMIN_ROOT} p[role='alert']`).filter({ hasText: "板块图" }),
          ).toBeVisible();
          await audit.capture("admin-forum-icon-invalid-error", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: [`${ADMIN_ROOT} p[role='alert']`],
          });
        });

        await audit.step("admin-authz-role-long-description", async () => {
          await page.goto("/admin/authz");
          await expect(page.getByText(fixture.roleDescription, { exact: true })).toBeVisible();
          await audit.capture("admin-authz-role-long-description", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            regions: [
              {
                name: "role",
                selector: `div.rounded-xl:has(> div > div > a[href="/admin/authz/${fixture.roleKey}"])`,
              },
            ],
          });
        });
        for (const scope of [0, 904]) {
          await audit.step(`admin-authz-role-grants-scope-${scope}`, async () => {
            await page.goto(
              `/admin/authz/${fixture.roleKey}${scope ? `?scopeForum=${scope}` : ""}`,
            );
            // 通过真实 summary 交互展开，而不是注入 DOM；词汇表原有长权限说明与授权/撤销按钮同时可测。
            const details = page.locator(`${ADMIN_ROOT} details`);
            for (const detail of await details.all()) {
              if ((await detail.getAttribute("open")) === null)
                await detail.locator("summary").click();
            }
            await expect(
              page.locator('input[name="permissionKey"][value="emoji.manage"]'),
            ).toHaveCount(1);
            await expect(
              page.getByText("管理社区表情（分组 / 上传 / 改名 / 排序 / 停用）", { exact: true }),
            ).toBeVisible();
            await expect(
              page.getByRole("button", { name: "已授权 ✓ 撤销", exact: true }).first(),
            ).toBeVisible();
            await audit.capture(`admin-authz-role-grants-scope-${scope}`, {
              roots: ADMIN_ROOT,
              buttons: ADMIN_BUTTONS,
              regions: [
                {
                  name: "long-permission",
                  selector: 'form:has(input[name="permissionKey"][value="emoji.manage"])',
                },
                {
                  name: "forum-permission",
                  selector: 'form:has(input[name="permissionKey"][value="forum.moderate"])',
                },
              ],
            });
          });
        }

        // 主题列表的内置行（Step 3f）：操作区新增了最长的按钮「重置为内置定义」，窄屏要换行，不能撑出横向滚动
        const builtinCard = page.locator(
          '[data-slot="card"]:has(input[name="id"][value="qy2010"]):has(input[name="revision"])',
        );
        const resetTrigger = builtinCard.getByRole("button", {
          name: "重置为内置定义",
          exact: true,
        });
        await audit.step("admin-themes-list-builtin-actions", async () => {
          await page.goto("/admin/themes");
          await expect(resetTrigger).toBeVisible();
          await audit.capture("admin-themes-list-builtin-actions", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: ['[data-slot="card"] form:has(input[name="revision"]) button'],
            regions: [
              { name: "builtin-cards", selector: '[data-slot="card"]:has(input[name="revision"])' },
            ],
          });
        });
        await audit.step("admin-themes-list-reset-confirm", async () => {
          // 只看确认框的布局，不真的重置：最后点取消
          await hydrated(resetTrigger);
          await resetTrigger.click();
          const dialog = page.getByRole("dialog", { name: "重置为内置定义？" });
          await expect(dialog).toBeVisible();
          await audit.capture("admin-themes-list-reset-confirm", {
            roots: '[role="dialog"]',
            buttons: '[role="dialog"] button',
            required: ['[role="dialog"]'],
            regions: [{ name: "dialog", selector: '[role="dialog"]' }],
          });
          await dialog.getByRole("button", { name: "取消", exact: true }).click();
          await expect(dialog).toHaveCount(0);
        });

        await audit.step("admin-themes-default-workspace", async () => {
          await page.goto("/admin/themes/default");
          await expect(page.getByRole("heading", { name: /编辑主题包/ })).toBeVisible();
          await expect(page.getByRole("region", { name: "主题区域设置" })).toBeVisible();
          await expect(page.getByTestId("theme-preview")).toBeVisible();
          await expect(page.getByTestId("theme-asset-library")).toBeVisible();
          await audit.capture("admin-themes-default-workspace", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: ['[data-testid="theme-preview"]', '[data-testid="theme-asset-library"]'],
            regions: [
              { name: "workspace", selector: 'section[aria-label="主题区域设置"]' },
              { name: "preview", selector: '[data-testid="theme-preview"]' },
            ],
          });
        });
        await audit.step("admin-themes-default-gradient-mobile-preview", async () => {
          await page.getByRole("button", { name: "公告横幅", exact: true }).click();
          await page.getByRole("radio", { name: "线性渐变", exact: true }).check();
          await page.getByRole("button", { name: "添加色标", exact: true }).click();
          await page
            .getByRole("group", { name: "预览宽度" })
            .getByRole("button", { name: "移动", exact: true })
            .click();
          await expect(page.getByTestId("theme-preview")).toHaveAttribute(
            "data-surface",
            "banner-announce",
          );
          await audit.capture("admin-themes-default-gradient-mobile-preview", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            regions: [
              { name: "gradient-controls", selector: 'section[aria-label="主题区域设置"]' },
              { name: "mobile-preview", selector: '[data-testid="theme-preview"]' },
            ],
          });
          // 仅修改浏览器内的草稿，不点保存/上传/全站预览，不改变 default 包。
        });
        await audit.step("admin-themes-default-color-field-invalid", async () => {
          // 颜色输入没写完时的错误态：提示文字在窄容器里要换行，不能撑出横向滚动
          const themeColor = page.getByRole("textbox", { name: "浏览器主题色", exact: true });
          await themeColor.fill("#12");
          await page.getByRole("textbox", { name: "填充色标 1 颜色", exact: true }).fill("#12");
          await expect(themeColor).toHaveAttribute("aria-invalid", "true");
          await expect(page.getByText(/当前仍使用 #0e7490/)).toBeVisible();
          await audit.capture("admin-themes-default-color-field-invalid", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            regions: [{ name: "color-fields", selector: 'section[aria-label="主题区域设置"]' }],
          });
        });
        const tokenPanel = page.getByTestId("theme-token-editor");
        const tokenRegion = [
          { name: "token-editor", selector: '[data-testid="theme-token-editor"]' },
        ];
        // 深色未启用时预览与对比度检查不渲染，那一步只要求面板本身
        const tokenParts = [
          '[data-testid="theme-token-editor"]',
          '[data-testid="token-preview"]',
          '[data-testid="contrast-panel"]',
        ];
        await audit.step("admin-themes-default-token-editor", async () => {
          // 全站语义令牌：展开并逐类覆盖，颜色、数字、下拉、复选框在窄容器里都要能换行，不撑出横向滚动
          await tokenPanel.locator("summary").click();
          await expect(tokenPanel.getByText(/没有覆盖的项继承默认主题/)).toBeVisible();
          for (const name of ["主色", "卡片上的文字", "阴影 1", "品牌渐变", "板块卡"]) {
            await page.getByRole("button", { name: `${name}：覆盖`, exact: true }).click();
          }
          await page.getByRole("checkbox", { name: "指定遮罩色", exact: true }).check();
          await page.getByRole("combobox", { name: "圆角", exact: true }).selectOption("md");
          await expect(
            page.getByRole("textbox", { name: "阴影 1 模糊", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("textbox", { name: "板块卡 遮罩色", exact: true }),
          ).toBeVisible();
          await audit.capture("admin-themes-default-token-editor", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: tokenParts,
            regions: tokenRegion,
          });
        });
        await audit.step("admin-themes-default-token-editor-invalid", async () => {
          // 错误态：三类输入（颜色、整数、小数）的提示文字在窄容器里要换行
          const color = page.getByRole("textbox", { name: "主色（全站）", exact: true });
          const blur = page.getByRole("textbox", { name: "阴影 1 模糊", exact: true });
          const width = page.getByRole("textbox", { name: "板块卡 图区宽度", exact: true });
          await color.fill("#12");
          await blur.fill("99");
          await width.fill("17");
          for (const field of [color, blur, width]) {
            await expect(field).toHaveAttribute("aria-invalid", "true");
          }
          await expect(tokenPanel.getByText("须为 0 到 80 的整数，当前仍使用 3")).toBeVisible();
          await expect(
            tokenPanel.getByText("须为 0 到 16 的数（最多 2 位小数），当前仍使用 7"),
          ).toBeVisible();
          await audit.capture("admin-themes-default-token-editor-invalid", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: tokenParts,
            regions: tokenRegion,
          });
        });
        await audit.step("admin-themes-default-token-contrast", async () => {
          // 对比度检查：正文覆盖成近白，出现本包造成的未达标行；展开全部 23 行，47 个按钮在窄容器里都要单行、不互相覆盖
          const panel = page.getByTestId("contrast-panel");
          await page.getByRole("button", { name: "正文：覆盖", exact: true }).click();
          await page.getByRole("textbox", { name: "正文（全站）", exact: true }).fill("#f8fafc");
          await expect(panel.getByText(/^5 项未达标，共 23 项/)).toBeVisible();
          await panel.getByRole("button", { name: "显示全部", exact: true }).click();
          await expect(panel.getByTestId("contrast-row")).toHaveCount(23);
          await audit.capture("admin-themes-default-token-contrast", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: ['[data-testid="contrast-panel"]'],
            regions: [{ name: "contrast-panel", selector: '[data-testid="contrast-panel"]' }],
          });
          // 「定位」：聚焦到对应的颜色行；预览吸顶时（按计算样式判断，不按设备），行不能被预览盖住
          await panel
            .getByRole("button", { name: "正文文字 / 页面底：定位正文", exact: true })
            .click();
          await expect(
            page.getByRole("textbox", { name: "正文（全站）", exact: true }),
          ).toBeFocused();
          const sticky = page.getByTestId("token-preview").locator("xpath=../..");
          if ((await sticky.evaluate((el) => getComputedStyle(el).position)) === "sticky") {
            const row = (await page.locator('[data-token-key="foreground"]').boundingBox())!;
            const box = (await sticky.boundingBox())!;
            expect(row.y).toBeGreaterThanOrEqual(box.y + box.height);
          }
        });
        await audit.step("admin-themes-default-token-editor-dark", async () => {
          // 深色档：未启用时只有说明与启用按钮；启用后是全部继承的空集，可再逐项覆盖
          const mode = page.getByRole("group", { name: "颜色模式" });
          await mode.getByRole("button", { name: "深色档", exact: true }).click();
          await expect(tokenPanel.getByText("深色未启用")).toBeVisible();
          await expect(tokenPanel.getByText(/本主题包没有深色令牌/)).toBeVisible();
          await expect(page.getByTestId("token-preview")).toHaveCount(0);
          await expect(page.getByTestId("contrast-panel")).toHaveCount(0);
          await audit.capture("admin-themes-default-token-editor-dark-off", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: ['[data-testid="theme-token-editor"]'],
            regions: tokenRegion,
          });
          await page.getByRole("button", { name: "启用深色令牌", exact: true }).click();
          await page.getByRole("button", { name: "主色：覆盖", exact: true }).click();
          await page.getByRole("button", { name: "阴影 2：覆盖", exact: true }).click();
          await expect(tokenPanel.getByText("已覆盖 2 项")).toBeVisible();
          await audit.capture("admin-themes-default-token-editor-dark-on", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: tokenParts,
            regions: tokenRegion,
          });
          // 仅修改浏览器内的草稿，不点保存，不改变 default 包。
        });

        await audit.step("admin-themes-qy2010-token-contrast", async () => {
          // qy2010 浅色档 23 对配对全部达标（Step 6b 换色后）
          await page.goto("/admin/themes/qy2010");
          await expect(page.getByRole("heading", { name: /编辑主题包/ })).toBeVisible();
          const qy2010Panel = page.getByTestId("theme-token-editor");
          // 摘要先于展开可见；对比度面板在折叠的 <details> 里，要先展开才可见
          await expect(qy2010Panel.getByText("已覆盖 29 项")).toBeVisible();
          await qy2010Panel.locator("summary").click();
          const contrast = page.getByTestId("contrast-panel");
          await expect(contrast.getByText(/^23 项全部达标/)).toBeVisible();
          await contrast.getByRole("button", { name: "显示全部", exact: true }).click();
          await expect(contrast.getByTestId("contrast-row")).toHaveCount(23);
          await audit.capture("admin-themes-qy2010-token-contrast", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: ['[data-testid="contrast-panel"]'],
            regions: [{ name: "contrast-qy2010", selector: '[data-testid="contrast-panel"]' }],
          });
        });

        await audit.step("admin-themes-default-invalid-issues", async () => {
          // 校验被拒时的具体问题列表（Step 3e）：带来 6 条，展示 5 条加「还有更多」；
          // 含很长的连续字符与很长的消息，窄屏上要换行，不撑出横向滚动
          await page.evaluate(() => sessionStorage.clear());
          const issues = [
            "surfaces.header.light.fill.stops.0.color: 非法颜色（须 #RRGGBB）",
            "tokens.dark.shadows.s1.blur: Too big: expected number to be <=80",
            `pwa.themeColor: ${"很长的消息".repeat(20)}`,
            `elsewhere.unknown.path.${"x".repeat(90)}: ${"y".repeat(60)}`,
            "tokens.light.band.width: Too big: expected number to be <=16",
            "surfaces.footer.light.blur: 该区域不支持此能力",
          ];
          const query = issues.map((issue) => `issue=${encodeURIComponent(issue)}`).join("&");
          await page.goto(`/admin/themes/default?err=invalid-definition&${query}`);
          const list = page.getByRole("list", { name: "未通过校验的项" });
          await expect(list.getByRole("listitem")).toHaveCount(6);
          await expect(list.getByText("还有更多问题未列出")).toBeVisible();
          await audit.capture("admin-themes-default-invalid-issues", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: ['ul[aria-label="未通过校验的项"]'],
            regions: [{ name: "issues", selector: 'ul[aria-label="未通过校验的项"]' }],
          });
        });

        // 运营排期：方案经界面创建并在结束时经界面删除（站点缓存只有走 Action 才会失效）。
        const campaignName = "排期布局回归".padEnd(60, "长");
        const campaignRow = page.getByTestId("campaign-row").filter({ hasText: campaignName });
        await audit.step("admin-campaigns-long-name", async () => {
          await page.goto("/admin/campaigns");
          await page.getByLabel("方案名称").fill(campaignName);
          await page.getByLabel("生效内容").selectOption("theme.pack::default");
          // 先停用再清理：未开始的窗口不会影响前台，避免布局测试期间改动站点默认主题
          await page.getByLabel(/^开始时间/).fill("2099-01-01T00:00");
          await page.getByRole("button", { name: "创建方案" }).click();
          await expect(page.getByText("排期方案已创建。")).toBeVisible();
          await expect(campaignRow).toBeVisible();
          await audit.capture("admin-campaigns-long-name", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: ['[data-testid="campaign-row"]'],
            regions: [{ name: "row", selector: '[data-testid="campaign-row"]' }],
          });
        });
        await audit.step("admin-campaigns-edit-and-error-echo", async () => {
          await campaignRow.getByRole("link", { name: "编辑" }).click();
          await expect(page.getByLabel("方案名称")).toHaveValue(campaignName);
          await page.getByLabel(/^结束时间/).fill("2098-01-01T00:00");
          await page.getByRole("button", { name: "保存修改" }).click();
          await expect(
            page.getByRole("alert").filter({ hasText: "结束时间必须晚于" }),
          ).toBeVisible();
          await expect(page.getByLabel("方案名称")).toHaveValue(campaignName);
          await audit.capture("admin-campaigns-edit-and-error-echo", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            regions: [{ name: "form", selector: `${ADMIN_ROOT} form` }],
          });
        });
        await audit.step("admin-campaigns-cleanup", async () => {
          await page.goto("/admin/campaigns");
          await campaignRow.getByRole("button", { name: "删除" }).click();
          await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
          await expect(campaignRow).toHaveCount(0);
        });

        // M11.4 行为类方案：长名称行（窗口设在 2099 年不影响前台；行为类必须填结束时间）
        const behaviorName = "E2E布局-开放注册".padEnd(60, "行");
        const behaviorRow = page.getByTestId("campaign-row").filter({ hasText: behaviorName });
        await audit.step("admin-campaigns-behavior-long-name", async () => {
          await page.goto("/admin/campaigns");
          await page.getByLabel("方案名称").fill(behaviorName);
          await page.getByLabel("生效内容").selectOption("register.open::on");
          await page.getByLabel(/^开始时间/).fill("2099-01-01T00:00");
          await page.getByLabel(/^结束时间/).fill("2099-06-01T00:00");
          await page.getByRole("button", { name: "创建方案" }).click();
          await expect(page.getByText("排期方案已创建。")).toBeVisible();
          await expect(behaviorRow).toBeVisible();
          await audit.capture("admin-campaigns-behavior-long-name", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            required: ['[data-testid="campaign-row"]'],
            regions: [{ name: "row", selector: '[data-testid="campaign-row"]' }],
          });
        });
        // 重叠错误回显（Q5）：同类行为方案时间重叠被拒，草稿保留
        await audit.step("admin-campaigns-behavior-overlap-error", async () => {
          await page.getByLabel("方案名称").fill("E2E布局-行为类重叠");
          await page.getByLabel("生效内容").selectOption("register.open::on");
          await page.getByLabel(/^开始时间/).fill("2099-02-01T00:00");
          await page.getByLabel(/^结束时间/).fill("2099-07-01T00:00");
          await page.getByRole("button", { name: "创建方案" }).click();
          await expect(page.getByRole("alert").filter({ hasText: "不能时间重叠" })).toBeVisible();
          await expect(page.getByLabel("方案名称")).toHaveValue("E2E布局-行为类重叠");
          await audit.capture("admin-campaigns-behavior-overlap-error", {
            roots: ADMIN_ROOT,
            buttons: ADMIN_BUTTONS,
            regions: [{ name: "form", selector: `${ADMIN_ROOT} form` }],
          });
        });
        // 设置页的窗口提示：短窗（约 9 分钟）内截图后立即删除——
        // responsive-register.spec 在本文件之后跑，不能带着生效中的开放注册窗口
        const soonEnd = new Date(Date.now() + (8 * 60 + 9) * 60_000).toISOString().slice(0, 16);
        const noticeName = "E2E布局-设置页提示";
        const noticeRow = page.getByTestId("campaign-row").filter({ hasText: noticeName });
        await audit.step("admin-settings-register-window-notice", async () => {
          await page.goto("/admin/campaigns");
          await page.getByLabel("方案名称").fill(noticeName);
          await page.getByLabel("生效内容").selectOption("register.open::on");
          await page.getByLabel(/^开始时间/).fill("");
          await page.getByLabel(/^结束时间/).fill(soonEnd);
          await page.getByRole("button", { name: "创建方案" }).click();
          await expect(page.getByText("排期方案已创建。")).toBeVisible();
          await page.goto("/admin/settings");
          await expect(page.getByTestId("register-window-notice")).toBeVisible();
          await audit.capture("admin-settings-register-window-notice", {
            roots: ADMIN_ROOT,
            regions: [{ name: "notice", selector: '[data-testid="register-window-notice"]' }],
          });
          await page.goto("/admin/campaigns");
          await noticeRow.getByRole("button", { name: "删除" }).click();
          await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
          await expect(noticeRow).toHaveCount(0);
        });
        await audit.step("admin-campaigns-behavior-cleanup", async () => {
          await page.goto("/admin/campaigns");
          await behaviorRow.getByRole("button", { name: "删除" }).click();
          await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
          await expect(behaviorRow).toHaveCount(0);
        });

        // M12 安装向导：step=1 表单（仅布局矩阵跑本场景——主 E2E 的库已 seed、STORAGE_DIR 无 lock，
        // 本用例的期望「向导可见」只有在矩阵专用库与专用 STORAGE_DIR 下才成立）
        if (process.env.LAYOUT_SPEC !== undefined || process.env.RUN_LAYOUT_SCREENSHOTS === "1") {
          await audit.step("admin-install-wizard", async () => {
            await page.goto("/install?step=1");
            await expect(page.getByRole("button", { name: "测试连接并建表" })).toBeVisible();
            await audit.capture("admin-install-wizard", {
              roots: "main",
              buttons: 'main button, main a[href^="/login"]',
              required: ["main form"],
              regions: [{ name: "wizard", selector: "main" }],
            });
          });
        }
      } finally {
        try {
          await fixture.cleanup();
        } finally {
          await audit.finish();
        }
      }
    });
  });
}
