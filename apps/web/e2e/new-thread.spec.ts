import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { USERS, loginAs } from "./support/session";

/**
 * 发主题 E2E（M6.2 第 2 步，桌面）。
 * 夹具：954「E2E 发帖区」公开、不审核，专供本用例写入（其它用例不读它的计数）；
 * 906 审核版块（review_policy=all），会员发帖进入待审；950 为分区，不能直接发帖。
 * 用例之间用时间戳区分标题，重复运行也成立。
 */

const COMPOSE = FIX.compose.id;
const REVIEW = 906;
const SECTION = 950;

test.describe("发新主题", () => {
  test("游客：版块页没有发帖入口；发帖页只提示登录，不渲染表单", async ({ page }) => {
    await page.goto(`/f/${COMPOSE}`);
    await expect(page.getByRole("link", { name: "发新主题" })).toHaveCount(0);

    await page.goto(`/f/${COMPOSE}/new`);
    await expect(page.getByText("登录后可在该版块发帖。")).toBeVisible();
    await expect(page.locator("#thread-title")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "去登录" })).toHaveAttribute("href", "/login");
  });

  test("会员：从版块页进入，发布后跳到新主题并看到标题", async ({ page, context }) => {
    await loginAs(context, USERS.member);
    await page.goto(`/f/${COMPOSE}`);
    await page.getByRole("link", { name: "发新主题" }).click();
    await expect(page).toHaveURL(new RegExp(`/f/${COMPOSE}/new$`));

    const title = `E2E 发帖 ${Date.now()}`;
    await page.locator("#thread-title").fill(title);
    await page.locator("#thread-source").fill("这是 E2E 发出的正文。");
    await page.getByRole("button", { name: "发布主题" }).click();

    await expect(page).toHaveURL(/\/t\/\d+$/);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByText("这是 E2E 发出的正文。")).toBeVisible();
  });

  test("失败回显与草稿恢复：空标题被拒，错误文案出现，正文原样回到输入框；补上标题即可发出", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.team);
    await page.goto(`/f/${COMPOSE}/new`);

    const body = `草稿正文 ${Date.now()}`;
    await page.locator("#thread-source").fill(body);
    await page.getByRole("button", { name: "发布主题" }).click();

    await expect(page.locator('p[role="alert"]')).toHaveText("请填写标题。");
    // 失败跳回后草稿恢复：正文还在，且 URL 里没有正文（只带固定错误码）
    await expect(page.locator("#thread-source")).toHaveValue(body);
    await expect(page).not.toHaveURL(new RegExp(body));

    const title = `E2E 补标题 ${Date.now()}`;
    await page.locator("#thread-title").fill(title);
    await page.getByRole("button", { name: "发布主题" }).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  });

  test("审核版块：入口带审核提示；提交后进入待审，作者本人看到审核中横幅", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.xiaoyi);
    await page.goto(`/f/${REVIEW}/new`);
    await expect(page.getByText("本版块的新主题需版主审核，通过后才对他人可见。")).toBeVisible();

    const title = `E2E 待审 ${Date.now()}`;
    await page.locator("#thread-title").fill(title);
    await page.locator("#thread-source").fill("待审正文");
    await page.getByRole("button", { name: "发布主题" }).click();

    await expect(page).toHaveURL(/\/t\/\d+$/);
    await expect(page.getByText("该主题正在审核中，目前只有你和版主能看到。")).toBeVisible();
  });

  test("分区不能直接发帖：说明文字，不渲染表单", async ({ page, context }) => {
    await loginAs(context, USERS.member);
    await page.goto(`/f/${SECTION}/new`);
    await expect(page.getByText("这是分区，请进入其中的版块发帖。")).toBeVisible();
    await expect(page.locator("#thread-title")).toHaveCount(0);
  });
});
