import { expect, test, type BrowserContext } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";
import { USERS, loginAs } from "./support/session";

/**
 * RSC 叶子请求 E2E（审查复查 A1）：伪造「客户端已持有父路由 layout，只导航到子页面」的请求，
 * 验证越权观众拿不到受限内容。起因是 `/admin/**` 曾因只在 layout 鉴权而被游客读到（P0，已修）；
 * 这里把同一种向量对其余页面全部过一遍。
 *
 * 方法要点（这是上次踩的坑）：
 *  · 每个目标都配**对照组**——有权者用同样的伪造请求必须拿得到标记词，否则「拿不到」可能只是请求写错；
 *  · 必须跟随 Next 的 `?_rsc=<hash>` 缓存破坏重定向（307），不能把这一跳当成鉴权结果；
 *  · 状态树描述「导航前所在的路由」：首页，或同级的另一个页面。Next 16 的动态段必须写成 4 元素
 *    `[参数名, 参数值, "d", null]`，3 元素会让服务端 500（"router state header ... could not be parsed"），
 *    那种 500 会让对照组失败，所以对照组同时也在验证请求构造本身。
 */

const HOME = ["", { children: ["__PAGE__", {}] }];
const fromT = [
  "",
  { children: ["t", { children: [["tid", "950001", "d", null], { children: ["__PAGE__", {}] }] }] },
];
const fromF = [
  "",
  { children: ["f", { children: [["fid", "951", "d", null], { children: ["__PAGE__", {}] }] }] },
];

interface Target {
  name: string;
  path: string;
  /** 只有有权观众的响应里才会出现的文字 */
  marker: string;
  trees: unknown[];
  /** 有权看到的观众（对照组） */
  allowed: number[];
  /** 无权的观众；null = 游客 */
  denied: (number | null)[];
}

let pendingTitle = "";

test.beforeAll(async () => {
  const [row] = await withE2eDb((q) =>
    q.query<{ title: string }>("SELECT title FROM threads WHERE id = 900007"),
  );
  pendingTitle = row!.title;
});

const targets = (): Target[] => [
  {
    name: "站务组版块（没有任何角色被授权，仅 admin）",
    path: `/f/${FIX.staff.id}`,
    marker: FIX.staffSecretTitle,
    trees: [HOME, fromF],
    allowed: [USERS.admin],
    denied: [null, USERS.member, USERS.team],
  },
  {
    name: "站务组里的主题",
    path: `/t/${FIX.thread.staffSecret}`,
    marker: "仅管理员可见。",
    trees: [HOME, fromT],
    allowed: [USERS.admin],
    denied: [null, USERS.member, USERS.team],
  },
  {
    name: "字幕组内部区的主题（仅团队）",
    path: "/t/900005",
    marker: FIX.teamSecretTitle,
    trees: [HOME, fromT],
    allowed: [USERS.team, USERS.admin],
    denied: [null, USERS.member, USERS.xiaoyi],
  },
  {
    name: "已删除的主题（仅版主）",
    path: `/t/${FIX.thread.deletedState}`,
    marker: "不应被任何人读到。",
    trees: [HOME, fromT],
    allowed: [USERS.admin],
    denied: [null, USERS.member, USERS.alice],
  },
  {
    name: "待审核的主题（仅作者与版主）",
    path: "/t/900007",
    marker: "__PENDING_TITLE__",
    trees: [HOME, fromT],
    allowed: [USERS.xiaoyi, USERS.admin],
    denied: [null, USERS.alice, USERS.member],
  },
  {
    name: "门控帖里的付费隐藏正文（已购买者可见）",
    path: `/t/${FIX.thread.gateAttach}`,
    marker: FIX.gateAttach.paidText,
    trees: [HOME, fromT],
    allowed: [USERS.member, USERS.alice, USERS.admin],
    denied: [null, USERS.xiaoyi, USERS.team],
  },
];

async function newCtx(
  browser: import("@playwright/test").Browser,
  uid: number | null,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: "http://127.0.0.1:3200" });
  if (uid !== null) await loginAs(ctx, uid);
  return ctx;
}

const rscGet = (ctx: BrowserContext, path: string, tree: unknown) =>
  // 默认跟随重定向：Next 先把不带 _rsc 的 RSC 请求 307 到 ?_rsc=<hash>，那一跳不是鉴权结果
  ctx.request.get(path, {
    headers: { rsc: "1", "next-router-state-tree": encodeURIComponent(JSON.stringify(tree)) },
  });

for (const idx of [0, 1, 2, 3, 4, 5]) {
  test(`RSC 叶子请求 #${idx + 1}：有权者拿得到（对照），越权者拿不到`, async ({ browser }) => {
    const t = targets()[idx]!;
    const marker = t.marker === "__PENDING_TITLE__" ? pendingTitle : t.marker;
    for (const tree of t.trees) {
      for (const uid of t.allowed) {
        const ctx = await newCtx(browser, uid);
        const res = await rscGet(ctx, t.path, tree);
        const body = await res.text();
        expect(res.status(), `对照 uid=${uid} ${t.name}`).toBe(200);
        expect(body, `对照 uid=${uid} ${t.name}（有权者应拿到标记词）`).toContain(marker);
        await ctx.close();
      }
      for (const uid of t.denied) {
        const ctx = await newCtx(browser, uid);
        const res = await rscGet(ctx, t.path, tree);
        const body = await res.text();
        expect(body, `越权 uid=${uid} ${t.name}`).not.toContain(marker);
        await ctx.close();
      }
    }
  });
}
