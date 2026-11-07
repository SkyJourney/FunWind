import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";
import { snapshotMailIds, waitForNewMail } from "./support/mailpit";

/**
 * M11.4：排期的行为类 effect——开放注册窗口（register.open）。
 * 方案与注册策略一律经后台界面切换（站点框架缓存只有走 Action 才会失效）；
 * afterAll 兜底清理本文件创建的方案与策略键，防止污染其他 spec（积分 / 注册用例对窗口敏感）。
 */

test.describe.configure({ mode: "serial" });
failOnPageErrors();

const PREFIX = "E2E行为排期-";
const PASSWORD = "e2e-password-123";
const unique = (tag: string) => `e2e_${tag}_${Date.now() % 1_000_000}`;

/** 北京墙面时间的 datetime-local 值，offsetHours 相对当前（可为小数，分钟精度） */
function beijing(offsetHours: number): string {
  return new Date(Date.now() + (8 + offsetHours) * 3600_000).toISOString().slice(0, 16);
}

async function createCampaign(
  page: Page,
  o: { name: string; choice: string; start?: string; end?: string },
): Promise<void> {
  await page.goto("/admin/campaigns");
  await page.getByLabel("方案名称").fill(o.name);
  await page.getByLabel("生效内容").selectOption(o.choice);
  await page.getByLabel(/^开始时间/).fill(o.start ?? beijing(-24));
  await page.getByLabel(/^结束时间/).fill(o.end ?? beijing(24));
  await page.getByRole("button", { name: "创建方案" }).click();
}

const rowOf = (page: Page, name: string) =>
  page.getByTestId("campaign-row").filter({ hasText: name });

/** 经后台界面切换注册策略（写库不会失效站点框架缓存），提交后等成功回执 */
async function savePolicy(
  admin: Page,
  flags: { open: boolean; verify: boolean; invite: boolean },
): Promise<void> {
  await admin.goto("/admin/settings");
  const set = async (name: string, on: boolean) => {
    const box = admin.locator(`#register input[name="${name}"]`);
    if (on) await box.check();
    else await box.uncheck();
  };
  await set("open", flags.open);
  await set("verifyEmail", flags.verify);
  await set("invite", flags.invite);
  await admin.getByRole("button", { name: "保存注册策略" }).click();
  await expect(admin.getByText(/注册策略已保存/).first()).toBeVisible();
}

async function deleteCampaign(page: Page, name: string): Promise<void> {
  await page.goto("/admin/campaigns");
  await rowOf(page, name).getByRole("button", { name: "删除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("排期方案已删除。")).toBeVisible();
  await expect(rowOf(page, name)).toHaveCount(0);
}

test.afterAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM campaigns WHERE name LIKE ?", [`${PREFIX}%`]);
    await q.exec("DELETE FROM site_settings WHERE `key` = 'register.policy'");
  });
});

test("开放注册窗口：窗口内可注册且须验证邮箱，到期回到站点设置原值", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await loginAs(adminCtx, USERS.admin);
  const admin = await adminCtx.newPage();
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();

  // 站点设为双关（经界面保存，顶栏缓存随之失效）：注册页关闭、顶栏无注册入口
  await savePolicy(admin, { open: false, verify: false, invite: false });
  await guestPage.goto("/register");
  await expect(guestPage.getByTestId("register-closed")).toBeVisible();
  await guestPage.goto("/");
  await expect(guestPage.getByRole("link", { name: "注册" })).toHaveCount(0);

  // 创建开放注册窗口（现在起 2 小时）
  const name = `${PREFIX}开放注册`;
  await createCampaign(admin, {
    name,
    choice: "register.open::on",
    start: beijing(-0.02),
    end: beijing(2),
  });
  await expect(admin.getByText("排期方案已创建。")).toBeVisible();
  await expect(rowOf(admin, name)).toContainText("生效中");

  // 游客：顶栏出现注册入口，注册页变为开放（注明须验证邮箱）
  await guestPage.goto("/");
  await expect(guestPage.getByRole("link", { name: "注册" })).toBeVisible();
  await guestPage.goto("/register");
  await expect(guestPage.getByText(/注册后需先验证邮箱才能登录/)).toBeVisible();

  // 游客不填邀请码直接注册：不建会话、发出验证邮件、登录门标记落库
  const name1 = unique("winreg");
  const email = `${name1}@test.local`;
  const known = await snapshotMailIds(email, "验证邮箱");
  await guestPage.getByLabel("用户名").fill(name1);
  await guestPage.getByLabel("邮箱").fill(email);
  await guestPage.getByLabel("密码（至少 8 位）").fill(PASSWORD);
  await guestPage.getByRole("button", { name: "注册" }).click();
  await expect(guestPage).toHaveURL(/\/login\?message=/);
  await expect(guestPage.getByText(/请查收邮箱/)).toBeVisible();
  expect(
    (await guestPage.context().cookies()).find((c) => c.name === "fw_session"),
  ).toBeUndefined();
  const mail = await waitForNewMail(email, "验证邮箱", known);
  expect(mail.ID).toBeTruthy();
  await withE2eDb(async (q) => {
    const [u] = await q.query<{ login_verification_required: number }>(
      "SELECT login_verification_required FROM users WHERE username = ?",
      [name1],
    );
    expect(u).toMatchObject({ login_verification_required: 1 });
  });

  // 窗口期打开后台设置页：勾选框仍是站点原值（全不勾）、窗口提示可见、双关警示不出现
  await admin.goto("/admin/settings");
  await expect(admin.locator('#register input[name="open"]')).not.toBeChecked();
  await expect(admin.locator('#register input[name="invite"]')).not.toBeChecked();
  await expect(admin.getByTestId("register-window-notice")).toContainText(name);
  await expect(admin.getByTestId("register-closed-warning")).toHaveCount(0);

  // 删除方案 → 注册页与顶栏回到站点设置原值（双关 = 关闭）
  await deleteCampaign(admin, name);
  await guestPage.goto("/register");
  await expect(guestPage.getByTestId("register-closed")).toBeVisible();

  // 复原站点策略为默认（邀请制），避免污染其他 spec
  await savePolicy(admin, { open: false, verify: false, invite: true });
  await guest.close();
  await adminCtx.close();
});

test("错误路径：窗口结束后旧表单提交被动作层拒绝，不建账号", async ({ browser }) => {
  // 用例内要真实等窗口过期（约 90 秒），超出默认单用例时限
  test.setTimeout(180_000);
  const adminCtx = await browser.newContext();
  await loginAs(adminCtx, USERS.admin);
  const admin = await adminCtx.newPage();
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();

  // 双关基线：窗口一结束注册就是「当前不开放注册」
  await savePolicy(admin, { open: false, verify: false, invite: false });

  // 短窗口：开始 ~2 分钟前、结束 ~1 分钟后（分钟精度取保守下界）
  const name = `${PREFIX}短窗`;
  await createCampaign(admin, {
    name,
    choice: "register.open::on",
    start: beijing(-0.03),
    end: beijing(0.02),
  });
  await expect(admin.getByText("排期方案已创建。")).toBeVisible();

  // 窗口内拿到开放注册表单并填好
  await guestPage.goto("/register");
  await expect(guestPage.getByText(/注册后需先验证邮箱才能登录/)).toBeVisible();
  const name1 = unique("expired");
  await guestPage.getByLabel("用户名").fill(name1);
  await guestPage.getByLabel("邮箱").fill(`${name1}@test.local`);
  await guestPage.getByLabel("密码（至少 8 位）").fill(PASSWORD);

  // 等窗口结束再提交（结束 ≤ +72 秒，等 90 秒留足余量）
  await guestPage.waitForTimeout(90_000);
  await guestPage.getByRole("button", { name: "注册" }).click();
  await expect(guestPage.getByText("当前不开放注册").first()).toBeVisible();
  await withE2eDb(async (q) => {
    expect(await q.query("SELECT id FROM users WHERE username = ?", [name1])).toHaveLength(0);
  });

  await deleteCampaign(admin, name);
  await savePolicy(admin, { open: false, verify: false, invite: true });
  await guest.close();
  await adminCtx.close();
});

test("错误路径：与生效窗口重叠被拒、行为类留空结束时间被拒（G-16 / D4 / D6）", async ({
  browser,
}) => {
  const adminCtx = await browser.newContext();
  await loginAs(adminCtx, USERS.admin);
  const admin = await adminCtx.newPage();

  // 基准：一个生效中的开放注册窗口（±24 小时）
  const base = `${PREFIX}长窗`;
  await createCampaign(admin, { name: base, choice: "register.open::on" });
  await expect(admin.getByText("排期方案已创建。")).toBeVisible();
  await expect(rowOf(admin, base)).toContainText("生效中");

  // 与生效窗口重叠的第二个方案被拒：专门提示、已填名称保留、不落库
  const overlap = `${PREFIX}重叠`;
  await createCampaign(admin, {
    name: overlap,
    choice: "register.open::on",
    start: beijing(-1),
    end: beijing(1),
  });
  await expect(admin.getByRole("alert").filter({ hasText: "不能时间重叠" })).toBeVisible();
  await expect(admin.getByLabel("方案名称")).toHaveValue(overlap);
  await expect(rowOf(admin, overlap)).toHaveCount(0);

  // 行为类结束时间留空被拒（D6）；视觉类不受限（M11.2 语义，campaigns.spec 已覆盖）
  const noEnd = `${PREFIX}无结束`;
  await createCampaign(admin, {
    name: noEnd,
    choice: "register.open::on",
    start: beijing(-24),
    end: "",
  });
  await expect(admin.getByRole("alert").filter({ hasText: "必须填写结束时间" })).toBeVisible();
  await expect(admin.getByLabel("方案名称")).toHaveValue(noEnd);
  await expect(rowOf(admin, noEnd)).toHaveCount(0);

  await deleteCampaign(admin, base);
  await adminCtx.close();
});
