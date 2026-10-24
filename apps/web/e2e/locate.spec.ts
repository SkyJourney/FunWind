import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";
import { USERS, loginAs } from "./support/session";

/**
 * /p/{pid} 定位路由（M6.1 第 6 步）。
 * 夹具：主题 FIX.thread.emoji（950001）。用例在其中临时造一条隐藏回帖，结束后删除。
 * 用原始请求（maxRedirects: 0）看 302 的地址，不跟随跳转。
 */

async function firstPostOf(threadId: number): Promise<{ id: number; floor: number }> {
  const [row] = await withE2eDb((q) =>
    q.query<{ id: number; floor: number }>(
      "SELECT id, floor FROM posts WHERE thread_id = ? ORDER BY floor ASC LIMIT 1",
      [threadId],
    ),
  );
  return row!;
}

test.describe("/p/{pid} 定位路由", () => {
  test("可见的帖子：302 到 /t/{tid}#p{pid}（首页不带 page 参数）；不存在或非法的 pid → 404", async ({
    request,
  }) => {
    const first = await firstPostOf(FIX.thread.emoji);
    const res = await request.get(`/p/${first.id}`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toBe(`/t/${FIX.thread.emoji}#p${first.id}`);
    expect((await request.get("/p/999999999", { maxRedirects: 0 })).status()).toBe(404);
    expect((await request.get("/p/abc", { maxRedirects: 0 })).status()).toBe(404);
  });

  test("隐藏的回帖：游客 404（不暴露存在性）；版主 302 到它所在的页与锚点", async ({
    context,
    request,
  }) => {
    const hidden = await withE2eDb(async (q) => {
      const [{ n }] = await q.query<{ n: number }>(
        "SELECT COALESCE(MAX(floor), 1) AS n FROM posts WHERE thread_id = ?",
        [FIX.thread.emoji],
      );
      const r = await q.exec(
        "INSERT INTO posts (thread_id, floor, author_id, body_md, state, created_at) VALUES (?, ?, ?, '隐藏的临时回帖', 'hidden', NOW())",
        [FIX.thread.emoji, n + 1, USERS.member],
      );
      return { id: r.insertId, floor: n + 1 };
    });
    try {
      expect((await request.get(`/p/${hidden.id}`, { maxRedirects: 0 })).status()).toBe(404);
      await loginAs(context, USERS.admin);
      const res = await context.request.get(`/p/${hidden.id}`, { maxRedirects: 0 });
      expect(res.status()).toBe(302);
      expect(res.headers()["location"]).toMatch(
        new RegExp(`^/t/${FIX.thread.emoji}(\\?page=\\d+)?#p${hidden.id}$`),
      );
    } finally {
      await withE2eDb((q) => q.exec("DELETE FROM posts WHERE id = ?", [hidden.id]));
    }
  });
});
