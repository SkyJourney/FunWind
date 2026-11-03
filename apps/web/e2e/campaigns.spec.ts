import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/**
 * M11.2：运营排期。方案一律经界面创建/删除——站点框架缓存是服务进程内存，
 * 直接写库不会失效它，会让后续 spec 在最多 30 秒内读到残留的站点默认主题。
 */

test.describe.configure({ mode: "serial" });
failOnPageErrors();

const PREFIX = "E2E排期-";

/** 北京墙面时间的 datetime-local 值，offsetHours 相对当前 */
function beijing(offsetHours: number): string {
  return new Date(Date.now() + (8 + offsetHours) * 3600_000).toISOString().slice(0, 16);
}

/** 游客视角读取站点生效的主题包：不带任何 cookie，排除管理员个人偏好的干扰 */
async function guestPack(request: APIRequestContext): Promise<string | undefined> {
  const html = await (await request.get("/")).text();
  return /<html[^>]*\sdata-pack="([^"]+)"/.exec(html)?.[1];
}

async function createCampaign(
  page: Page,
  o: { name: string; choice: string; start?: string; end?: string; priority?: string },
): Promise<void> {
  await page.goto("/admin/campaigns");
  await page.getByLabel("方案名称").fill(o.name);
  await page.getByLabel("生效内容").selectOption(o.choice);
  await page.getByLabel(/^开始时间/).fill(o.start ?? beijing(-24));
  await page.getByLabel(/^结束时间/).fill(o.end ?? beijing(24));
  if (o.priority) await page.getByLabel(/^优先级/).fill(o.priority);
  await page.getByRole("button", { name: "创建方案" }).click();
}

const rowOf = (page: Page, name: string) =>
  page.getByTestId("campaign-row").filter({ hasText: name });

test.afterAll(async () => {
  await withE2eDb((q) => q.exec("DELETE FROM campaigns WHERE name LIKE ?", [`${PREFIX}%`]));
});

test("会员访问运营排期 → 404", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  expect((await page.goto("/admin/campaigns"))?.status()).toBe(404);
});

test("时间窗内的方案对游客生效，删除后立即回退", async ({ page, context, request }) => {
  await loginAs(context, USERS.admin);
  const name = `${PREFIX}生效`;
  expect(await guestPack(request)).toBe("default");

  await createCampaign(page, { name, choice: "theme.pack::qy2010" });
  await expect(page.getByText("排期方案已创建。")).toBeVisible();
  await expect(rowOf(page, name)).toContainText("生效中");
  expect(await guestPack(request)).toBe("qy2010");

  await rowOf(page, name).getByRole("button", { name: "删除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("排期方案已删除。")).toBeVisible();
  expect(await guestPack(request)).toBe("default");
});

test("未开始与已结束的方案不影响前台，状态徽标正确", async ({ page, context, request }) => {
  await loginAs(context, USERS.admin);
  const future = `${PREFIX}未开始`;
  const past = `${PREFIX}已结束`;
  await createCampaign(page, {
    name: future,
    choice: "theme.pack::qy2010",
    start: beijing(48),
    end: beijing(72),
  });
  await createCampaign(page, {
    name: past,
    choice: "theme.pack::qy2010",
    start: beijing(-72),
    end: beijing(-48),
  });
  await expect(rowOf(page, future)).toContainText("未开始");
  await expect(rowOf(page, past)).toContainText("已结束");
  expect(await guestPack(request)).toBe("default");
  for (const name of [future, past]) {
    await rowOf(page, name).getByRole("button", { name: "删除" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
    await expect(rowOf(page, name)).toHaveCount(0);
  }
});

test("错误路径：结束早于开始被拒，已填内容原样保留且不落库", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  const name = `${PREFIX}错误`;
  await createCampaign(page, {
    name,
    choice: "theme.pack::qy2010",
    start: beijing(10),
    end: beijing(2),
    priority: "7",
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "结束时间必须晚于开始时间" }),
  ).toBeVisible();
  await expect(page.getByLabel("方案名称")).toHaveValue(name);
  await expect(page.getByLabel(/^优先级/)).toHaveValue("7");
  await expect(page.getByLabel("生效内容")).toHaveValue("theme.pack::qy2010");
  await expect(rowOf(page, name)).toHaveCount(0);
});

test("同类方案重叠：优先级高者生效，停用后由次高者接替", async ({ page, context, request }) => {
  await loginAs(context, USERS.admin);
  const low = `${PREFIX}低优先`;
  const high = `${PREFIX}高优先`;
  await createCampaign(page, { name: low, choice: "theme.pack::qy2010", priority: "1" });
  await createCampaign(page, { name: high, choice: "theme.pack::default", priority: "9" });
  await expect(rowOf(page, low)).toContainText("被方案");
  expect(await guestPack(request)).toBe("default"); // 高优先级的 default 压过 qy2010

  await rowOf(page, high).getByRole("button", { name: "停用" }).click();
  await expect(rowOf(page, high)).toContainText("已停用");
  expect(await guestPack(request)).toBe("qy2010"); // 次高者接替

  for (const name of [low, high]) {
    await rowOf(page, name).getByRole("button", { name: "删除" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
    await expect(rowOf(page, name)).toHaveCount(0);
  }
});

test("版本冲突：旧草稿保留且不能保存，放弃后载入最新版本", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  const name = `${PREFIX}冲突`;
  await createCampaign(page, { name, choice: "theme.pack::qy2010" });
  await rowOf(page, name).getByRole("link", { name: "编辑" }).click();
  await expect(page.getByLabel("方案名称")).toHaveValue(name);

  // 另一个标签页先改动（停用也会使 revision+1），当前页持有的是旧版本
  const other = await context.newPage();
  await other.goto("/admin/campaigns");
  await rowOf(other, name).getByRole("button", { name: "停用" }).click();
  await expect(rowOf(other, name)).toContainText("已停用");
  await other.close();

  await page.getByLabel("方案名称").fill(`${name}-我的改动`);
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "版本冲突" }).first()).toBeVisible();
  await expect(page.getByLabel("方案名称")).toHaveValue(`${name}-我的改动`);
  await expect(page.getByRole("button", { name: "保存修改" })).toBeDisabled();

  await page.getByRole("link", { name: "放弃草稿并载入最新版本" }).click();
  await expect(page.getByLabel("方案名称")).toHaveValue(name);
  await expect(page.getByRole("button", { name: "保存修改" })).toBeEnabled();

  await rowOf(page, name).getByRole("button", { name: "删除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
  await expect(rowOf(page, name)).toHaveCount(0);
});
