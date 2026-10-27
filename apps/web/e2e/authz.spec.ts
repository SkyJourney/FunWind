import { expect, test, type BrowserContext } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";
import { USERS, loginAs } from "./support/session";

/**
 * 权限内核 E2E（schema v2.1）。受限版块（read_policy=restricted）：
 *   · 演示种子 904 字幕组内部区——演示团队角色 demo-team 持有它的 forum.read/write 授权；
 *   · E2E 夹具 953 站务组——没有任何角色被授权，只有 admin（评估器短路放行）读得到。
 */

const RESTRICTED_FORUMS = [FIX.teamForum.id, FIX.staff.id];
const RESTRICTED_NAMES = [FIX.teamForum.name, FIX.staff.name];
const RESTRICTED_TITLES = [FIX.teamSecretTitle, FIX.staffSecretTitle];
const SECRET_THREAD = { id: 900005, title: FIX.teamSecretTitle };

test.describe("权限内核", () => {
  test("隔离校验：E2E server 连接的是隔离库", async ({ request }) => {
    const r = await request.get("/api/dev/whoami");
    const body = (await r.json()) as { database: string };
    expect(body.database).toBe("qysub_next_e2e");
  });

  test("游客可读公开版块", async ({ page }) => {
    await page.goto(`/f/${FIX.anime.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("E2E 动画");
  });

  test("受限版块：游客 → 404（不暴露存在性）", async ({ page }) => {
    for (const fid of RESTRICTED_FORUMS) {
      const res = await page.goto(`/f/${fid}`);
      expect(res?.status(), `fid ${fid}`).toBe(404);
    }
    for (const tid of [SECRET_THREAD.id, FIX.thread.staffSecret]) {
      expect((await page.goto(`/t/${tid}`))?.status(), `tid ${tid}`).toBe(404);
    }
  });

  test("P0 泄露回归：游客首页与版块页的任何位置都搜不到受限版块的名称或其主题标题", async ({
    page,
  }) => {
    for (const path of ["/", `/f/${FIX.anime.id}`, `/f/${FIX.water.id}`]) {
      await page.goto(path);
      const html = await page.content();
      for (const name of RESTRICTED_NAMES) expect(html, `${path} 含 ${name}`).not.toContain(name);
      for (const title of RESTRICTED_TITLES) {
        expect(html, `${path} 含受限主题标题`).not.toContain(title);
      }
    }
    // 首页统计只算访客可见且上目录的版块：与数据库独立算出的期望值逐字对比，且必然小于版块总数
    const [{ visible, total }] = await withE2eDb((q) =>
      q.query<{ visible: number; total: number }>(
        `SELECT SUM(is_listed = 1 AND read_policy <> 'restricted') AS visible, COUNT(*) AS total
           FROM forums WHERE kind = 'forum'`,
      ),
    );
    expect(Number(visible)).toBeLessThan(Number(total));
    await page.goto("/");
    await expect(page.getByText(new RegExp(`${visible} 个版块`))).toBeVisible();
  });

  test("受限版块：普通会员 → 404", async ({ page, context }) => {
    await loginAs(context, USERS.member);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "demo_member" })).toBeVisible(); // 确认已登录（用户菜单触发按钮）
    for (const fid of RESTRICTED_FORUMS) {
      const res = await page.goto(`/f/${fid}`);
      expect(res?.status(), `fid ${fid}`).toBe(404);
    }
    const html = await (await page.goto("/"))!.text();
    for (const name of RESTRICTED_NAMES) expect(html).not.toContain(name);
  });

  test("演示团队成员：可读自己被授权的 904（含主题），但读不到别的受限版块", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.team);
    await page.goto("/f/904");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("字幕组内部区");
    await expect(page.getByRole("link", { name: SECRET_THREAD.title }).first()).toBeVisible();
    await page.goto(`/t/${SECRET_THREAD.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("字幕分工表");
    // 首页目录里该成员能看到 904
    await page.goto("/");
    await expect(page.getByRole("link", { name: "『字幕组内部区』" }).first()).toBeVisible();
    // 授权是按版块的：demo-team 没有 953 的授权
    expect((await page.goto(`/f/${FIX.staff.id}`))?.status()).toBe(404);
  });

  test("非 admin 访问后台 → 404（不暴露后台存在）", async ({ page, context }) => {
    await loginAs(context, USERS.member);
    expect((await page.goto("/admin/authz"))?.status()).toBe(404);
  });

  test("后台页面自己也鉴权：伪造 RSC 局部渲染请求（假装已持有父路由的 layout）绕不过去（审查 P2-15）", async ({
    browser,
  }) => {
    // 真实的绕过向量：客户端已持有 /admin 的 layout，只「导航」到子页面——服务端按路由状态树做差，
    // 只渲染变化的叶子，layout 不再执行。状态树因此必须描述「导航前所在的父路由」。
    const state = (children: unknown) => ["", { children: ["admin", children] }];
    const atAdmin = state({ children: ["__PAGE__", {}] }); // 当前在 /admin
    const atAuthz = state({ children: ["authz", { children: ["__PAGE__", {}] }] }); // 当前在 /admin/authz
    const targets: { path: string; tree: unknown; marker: string }[] = [
      { path: "/admin/authz", tree: atAdmin, marker: "新建自定义角色" },
      { path: "/admin/authz/member", tree: atAuthz, marker: "admin.roles" },
      { path: `/admin/authz/forum/${FIX.staff.id}`, tree: atAuthz, marker: "仅授权角色" },
    ];
    const rscGet = (ctx: BrowserContext, t: { path: string; tree: unknown }) =>
      ctx.request.get(t.path, {
        headers: { rsc: "1", "next-router-state-tree": encodeURIComponent(JSON.stringify(t.tree)) },
        // Next 会先把不带 _rsc 参数的 RSC 请求 307 到 ?_rsc=<hash>（缓存破坏），必须跟随这一跳，
        // 否则看到的 307 只是这一跳而不是鉴权结果
      });
    const newCtx = async (uid: number | null) => {
      const ctx = await browser.newContext({ baseURL: "http://127.0.0.1:3200" });
      if (uid !== null) await loginAs(ctx, uid);
      return ctx;
    };

    // 对照：admin 用同样的伪造请求能拿到页面内容——证明这条向量确实只渲染叶子、
    // 下面「拿不到」不是因为请求写错或标记词不对
    const adminCtx = await newCtx(USERS.admin);
    for (const t of targets) {
      const res = await rscGet(adminCtx, t);
      expect(res.status(), `admin ${t.path}`).toBe(200);
      expect(await res.text(), `admin ${t.path}`).toContain(t.marker);
    }
    await adminCtx.close();

    for (const [label, uid] of [
      ["游客", null],
      ["普通会员", USERS.member],
      ["团队成员", USERS.team],
    ] as const) {
      const ctx = await newCtx(uid);
      for (const t of targets) {
        const res = await rscGet(ctx, t);
        const where = `${label} · ${t.path}`;
        const body = await res.text();
        expect(body, where).not.toContain(t.marker);
        // 游客被引去登录页，登录的非 admin 一律 404
        // 游客：RSC 响应里携带的是跳转到 /login 的指令（200 状态的流式载荷），而不是页面内容
        if (uid === null) expect(body, where).toContain("/login");
        // 登录的非 admin：RSC 流里是「找不到」的错误边界（状态码仍是 200 的流），不含页面内容
        else
          expect(body, where).toMatch(
            /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND|could not be found/,
          );
      }
      await ctx.close();
    }
  });

  test("admin：可读全部受限版块 + 后台授权矩阵 + 版块权限视角", async ({ page, context }) => {
    await loginAs(context, USERS.admin);

    // ① 受限版块：admin 全部可读
    await page.goto(`/f/${FIX.staff.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("E2E 站务组");
    await page.goto(`/f/${FIX.teamForum.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("字幕组内部区");

    // ② 后台：site.admin 总门放行
    await page.goto("/admin/authz");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("后台管理");

    // ③ 授权矩阵：进入 admin 角色可见权限点
    await page.getByRole("link", { name: "管理员" }).click();
    await expect(page).toHaveURL(/\/admin\/authz\/admin/);
    await expect(page.getByText("site.admin")).toBeVisible();
    await expect(page.getByText("admin.roles")).toBeVisible();

    // ④ 版块视角：有效策略 + 版主 + 作用域链
    await page.goto(`/admin/authz/forum/${FIX.staff.id}`);
    await expect(page.getByText("有效策略")).toBeVisible();
    await expect(page.getByText("仅授权角色").first()).toBeVisible(); // 953 的读策略 restricted
    await expect(page.getByText("版主（持有 forum.moderate")).toBeVisible();
    await expect(page.getByText("作用域链")).toBeVisible();
  });
});
