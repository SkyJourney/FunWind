import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";
import { USERS, loginAs } from "./support/session";

/**
 * 门控附件 E2E（docs/ATTACHMENT-GATES.md）。
 * 夹具：帖 FIX.thread.gateAttach 有两个门控——a1 付费 10、a2 回复可见——和四个附件：
 *   公开附件.txt（公开）/ 付费附件.txt + 门控图.png（绑定 a1）/ 回复可见附件.txt（绑定 a2）；
 *   门控图同时嵌在 a1 的隐藏正文里。demo_member 已购买 a1；alice 是作者。
 * 核心：锁定的附件不出现在页面里（名字、存储键都没有），直接请求 /files 也是 404；
 *       解锁者拿得到；门控图不进共享缓存；游客/未解锁者与解锁者的页面和 /files 结论一致。
 */
const G = FIX.gateAttach;
const URL_PATH = `/t/${FIX.thread.gateAttach}`;

let key: Record<string, string>;

test.beforeAll(async () => {
  const rows = await withE2eDb((q) =>
    q.query<{ original_name: string; storage_key: string }>(
      `SELECT a.original_name, f.storage_key FROM attachments a JOIN files f ON f.id = a.file_id
        JOIN posts p ON p.id = a.post_id WHERE p.thread_id = ${FIX.thread.gateAttach}`,
    ),
  );
  key = Object.fromEntries(rows.map((r) => [r.original_name, r.storage_key]));
  expect(Object.keys(key).sort()).toEqual(
    [G.publicName, G.paidName, G.paidImageName, G.replyName].sort(),
  );
});

const files = (name: string) => `/files/${key[name]}`;

test.describe("游客与未解锁者：看不到、取不到", () => {
  test("游客：页面只有公开附件与「N 个附件需解锁」，没有被锁附件的名字 / 存储键 / 隐藏正文；直接请求全部 404", async ({
    page,
    request,
  }) => {
    await page.goto(URL_PATH);
    await expect(page.getByText(G.publicName)).toBeVisible();
    await expect(page.getByTestId("locked-attachments")).toHaveText(/本帖有 3 个附件需解锁后下载/);

    const html = await page.content();
    for (const secret of [G.paidName, G.paidImageName, G.replyName, G.paidText, G.replyText]) {
      expect(html, secret).not.toContain(secret);
    }
    for (const n of [G.paidName, G.paidImageName, G.replyName]) {
      expect(html, n).not.toContain(key[n]);
    }
    // 游客没有 attachment.download：连公开的非图片附件也取不到；被锁的图片同样 404
    for (const n of [G.publicName, G.paidName, G.paidImageName, G.replyName]) {
      expect((await request.get(files(n))).status(), n).toBe(404);
    }
  });

  test("登录但未解锁的会员：能下载公开附件，被锁的 404；页面同样不下发被锁附件的任何信息", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.xiaoyi);
    await page.goto(URL_PATH);
    await expect(page.getByRole("link", { name: new RegExp(G.publicName) })).toBeVisible();
    await expect(page.getByTestId("locked-attachments")).toHaveText(/本帖有 3 个附件需解锁后下载/);
    const html = await page.content();
    for (const n of [G.paidName, G.paidImageName, G.replyName]) {
      expect(html, n).not.toContain(n);
      expect(html, n).not.toContain(key[n]);
    }
    expect((await page.request.get(files(G.publicName))).status()).toBe(200);
    for (const n of [G.paidName, G.paidImageName, G.replyName]) {
      expect((await page.request.get(files(n))).status(), n).toBe(404);
    }
  });
});

test.describe("解锁者与作者：取得到", () => {
  test("已购买付费门控的会员：付费附件与门控图可取，回复门控的仍锁；门控图不进共享缓存", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.member);
    await page.goto(URL_PATH);
    await expect(page.getByRole("link", { name: new RegExp(G.paidName) })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(G.paidImageName) })).toBeVisible();
    await expect(page.getByText(G.paidText)).toBeVisible();
    await expect(page.getByTestId("locked-attachments")).toHaveText(/本帖有 1 个附件需解锁后下载/);
    expect(await page.content()).not.toContain(G.replyName);

    // 隐藏正文里嵌的门控图：真实解码成功
    const img = page.locator(`.content-md img[src="${files(G.paidImageName)}"]`);
    await expect(img).toHaveCount(1);
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);

    const paid = await page.request.get(files(G.paidName));
    expect(paid.status()).toBe(200);
    expect(paid.headers()["content-disposition"]).toMatch(/^attachment;/);
    expect(paid.headers()["cache-control"]).toBe("private, no-store");

    const gatedImg = await page.request.get(files(G.paidImageName));
    expect(gatedImg.status()).toBe(200);
    const h = gatedImg.headers();
    expect(h["content-type"]).toBe("image/png");
    expect(h["cache-control"]).toBe("private, no-store");
    expect(h["etag"]).toBeUndefined();
    // 携带 ETag 也不会因 304 绕过鉴权（这里已登录且有权，必须是完整的 200）
    expect(
      (
        await page.request.get(files(G.paidImageName), {
          headers: {
            "if-none-match": '"0000000000000000000000000000000000000000000000000000000000000000"',
          },
        })
      ).status(),
    ).toBe(200);

    expect((await page.request.get(files(G.replyName))).status()).toBe(404);
  });

  test("作者：四个附件都可见可取，没有「需解锁」提示", async ({ page, context }) => {
    await loginAs(context, USERS.alice);
    await page.goto(URL_PATH);
    await expect(page.getByTestId("locked-attachments")).toHaveCount(0);
    for (const n of [G.publicName, G.paidName, G.paidImageName, G.replyName]) {
      await expect(
        page.getByRole("link", { name: new RegExp(n.replace(".", "\\.")) }),
      ).toBeVisible();
      expect((await page.request.get(files(n))).status(), n).toBe(200);
    }
  });
});
