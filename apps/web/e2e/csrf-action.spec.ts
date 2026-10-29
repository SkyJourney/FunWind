import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";

/**
 * Server Action 的跨站请求防护 E2E（审查复查 A3）。
 * 审查报告写过「Next 默认校验 Origin」，但那只是凭文档，没验证过。这里用真实的购买动作验证：
 *  · 对照：同源 Origin 的提交会生效（免费门控被解锁），证明请求构造正确；
 *  · 跨站 Origin 的提交被拒绝，且没有任何副作用。
 * 站点没有配置 serverActions.allowedOrigins，所以比对的是 Origin 与 Host。
 */

const TID = 991010;
const POST = TID + 100;
// 同源对照的 Origin 取自测试配置（dev 3200 / prod 3201 各自正确）；跨站伪造值不变
const ORIGIN = "http://127.0.0.1:3201";

test.describe.configure({ mode: "serial" });

const reset = () =>
  withE2eDb(async (q) => {
    await q.exec("DELETE FROM gate_unlocks WHERE gate_id = ?", [TID]);
    await q.exec("DELETE FROM post_gates WHERE id = ?", [TID]);
    await q.exec("DELETE FROM posts WHERE thread_id = ?", [TID]);
    await q.exec("DELETE FROM threads WHERE id = ?", [TID]);
  });

test.beforeAll(async () => {
  await reset();
  await withE2eDb(async (q) => {
    await q.exec(
      `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, created_at, last_posted_at)
       VALUES (?, 901, ?, '[E2E] CSRF 免费门控', ?, 'visible', '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
      [TID, USERS.alice, POST],
    );
    await q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
       VALUES (?, ?, 1, ?, ?, 1, 'visible', '2026-10-21 10:00:00')`,
      [POST, TID, USERS.alice, '免费门控\n\n:::gate{key="g1"}\n:::'],
    );
    await q.exec(
      `INSERT INTO post_gates (id, post_id, gate_key, conditions, match_mode, hidden_md, created_at, updated_at)
       VALUES (?, ?, 'g1', ?, 'all', 'CSRF-隐藏内容', '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
      [TID, POST, JSON.stringify([{ type: "points", price: 0 }])],
    );
  });
});
test.afterAll(reset);

const unlocked = () =>
  withE2eDb(async (q) => {
    const rows = await q.query<{ n: number }>(
      "SELECT COUNT(*) n FROM gate_unlocks WHERE gate_id = ? AND user_id = ?",
      [TID, USERS.team],
    );
    return Number(rows[0]!.n) > 0;
  });
const clearUnlock = () =>
  withE2eDb((q) =>
    q.exec("DELETE FROM gate_unlocks WHERE gate_id = ? AND user_id = ?", [TID, USERS.team]),
  );

test("跨站 Origin 的 Server Action 提交被拒绝且无副作用；同源提交（对照）生效", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ baseURL: ORIGIN });
  await loginAs(ctx, USERS.team);

  // 从页面里取出购买表单的 action 标识（React 把 Server Action 序列化成隐藏字段）
  const html = await (await ctx.request.get(`/t/${TID}`)).text();
  // 页面里不止一个 Server Action 表单（顶栏还有退出登录），必须取含 gateId 字段的那个
  const form = [...html.matchAll(/<form[\s\S]*?<\/form>/g)]
    .map((m) => m[0])
    .find((f) => f.includes('name="gateId"'));
  const actionName = form && /name="(\$ACTION_ID_[0-9a-f]+)"/.exec(form)?.[1];
  expect(actionName, "页面里应能找到购买表单的 Server Action 标识").toBeTruthy();

  const submit = (origin: string | null) =>
    ctx.request.post(`/t/${TID}`, {
      headers: origin === null ? {} : { origin },
      multipart: {
        [actionName!]: "",
        gateId: String(TID),
        page: "1",
        expectedPrice: "0",
      },
      maxRedirects: 0,
    });

  // 对照：同源 Origin → 动作执行（免费门控被解锁）
  const ok = await submit(ORIGIN);
  expect([200, 303, 307]).toContain(ok.status());
  expect(await unlocked(), "同源提交应当生效，否则请求构造有误、下面的负例没有意义").toBe(true);
  await clearUnlock();

  // 负例：跨站 Origin → 拒绝，且没有副作用
  for (const evil of ["https://evil.example", "http://127.0.0.1:9999", "null"]) {
    const res = await submit(evil);
    expect(res.status(), `Origin=${evil}`).toBeGreaterThanOrEqual(400);
    expect(await unlocked(), `Origin=${evil} 不应产生副作用`).toBe(false);
  }

  // 补充（复查记录）：不带 Origin 头的提交会被 Next 接受（实测 303 且生效）。这是预期行为——浏览器的跨站 POST
  // 一定带 Origin（上面已拒绝），且 Lax 会话 cookie 不会随跨站 POST 发出；非浏览器客户端本来就拿不到别人的会话。
  // 部署在反向代理后须保证 Host / X-Forwarded-Host 正确，否则同源提交也会被误拒（M13 上线核对项）。
  await ctx.close();
});
