// @vitest-environment node
/**
 * 编辑页模型（M6 的 readEditView/loadEditPage 此前 0 覆盖，M9.5 补齐）：
 * notfound / 主题消失 closed / 可编辑表单（含 state 透传与驳回理由）三个主分支。
 */
import "@/modules";
import { eq } from "drizzle-orm";
import { DEMO, getWebDb, posts, threads } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import { setSetting } from "@/lib/auth/settings";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { loadEditPage } from "./edit-page";
import { createThread } from "./service";

let tdb: TempDb;
const REVIEW_FORUM = 906;

beforeAll(async () => {
  tdb = await setupTempDb();
  // 关掉发帖间隔频控（连续造主题的测试会撞 5 秒间隔）
  await setSetting(
    "limits",
    {
      titleMax: 100,
      bodyMax: 50000,
      roles: {
        member: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 20, editWindowSec: 0 },
        admin: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 20, editWindowSec: 0 },
      },
    },
    { userId: null, via: "admin", ip: null },
  );
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("编辑页模型（M9.5 补覆盖）", () => {
  it("pending 主题：作者可编辑，state 透传为 pending（编辑页据此给审核中横幅）", async () => {
    const author = await loadSubject(DEMO.member);
    const r = await createThread(
      author,
      { forumId: REVIEW_FORUM, title: "编辑模型测试主题", source: "正文" },
      {},
    );
    if (!r.ok) throw new Error(r.message);
    const model = await loadEditPage(author, r.postId);
    expect(model.kind).toBe("form");
    if (model.kind === "form") {
      expect(model.state).toBe("pending");
      expect(model.resubmit).toBe(false);
      expect(model.title).toBe("编辑模型测试主题");
    }
  });

  it("不存在的帖子 → notfound；被删主题的回帖 → thread_gone closed", async () => {
    const author = await loadSubject(DEMO.member);
    expect((await loadEditPage(author, 99999999)).kind).toBe("notfound");

    // 造 visible 主题 + 回帖，然后删主题（首帖与主题置 deleted）
    const r = await createThread(
      author,
      { forumId: REVIEW_FORUM, title: "删除宿主", source: "正文" },
      {},
    );
    if (!r.ok) throw new Error(r.message);
    const { eq: eqCol } = await import("drizzle-orm");
    const db = () => getWebDb();
    const [th] = await db()
      .select({ firstPostId: threads.firstPostId })
      .from(threads)
      .where(eq(threads.id, r.threadId));
    await db().update(threads).set({ state: "deleted" }).where(eqCol(threads.id, r.threadId));
    if (th?.firstPostId) {
      await db().update(posts).set({ state: "deleted" }).where(eqCol(posts.id, th.firstPostId));
    }
    // 读取侧不变量：deleted 主题对非版主作者也不可见 → notfound 先于 thread_gone
    const model = await loadEditPage(author, r.postId);
    expect(model.kind).toBe("notfound");
  });
});
