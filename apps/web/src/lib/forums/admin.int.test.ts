// @vitest-environment node
/**
 * 版块管理服务集成测试（M10.6a）：创建（path/depth 回填）、更新（父级迁移重算子树）、
 * 删除保护（有子级/有主题）、前缀 CRUD、审计随事务落库。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, forums, getWebDb } from "@funwind/db";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  addPrefix,
  createForum,
  deleteForum,
  listPrefixes,
  removePrefix,
  updateForum,
} from "./admin";

let tdb: TempDb;
const ACTOR = { userId: 2, ip: "127.0.0.1" };

beforeAll(async () => {
  tdb = await setupTempDb({ demo: false });
});

afterAll(() => {
  tdb?.teardown();
});

describe.skipIf(skipDb)("版块管理服务（M10.6a）", () => {
  it("createForum：根版块与嵌套版块的物化路径/深度正确，审计落库", async () => {
    const section = await createForum(ACTOR, {
      parentId: 0,
      kind: "section",
      name: "测试分区",
      description: null,
      icon: "",
      sortOrder: 1,
      isListed: true,
    });
    expect(section).toMatchObject({ ok: true });
    if (!section.ok) return;
    const forum = await createForum(ACTOR, {
      parentId: section.id,
      kind: "forum",
      name: "测试版块",
      description: "说明",
      icon: "",
      sortOrder: 2,
      isListed: true,
    });
    expect(forum).toMatchObject({ ok: true });
    if (!forum.ok) return;

    const db = getWebDb();
    const [row] = await db.select().from(forums).where(eq(forums.id, forum.id));
    expect(row.parentId).toBe(section.id);
    expect(row.path).toBe(`/${section.id}/${forum.id}/`);
    expect(row.depth).toBe(2);

    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetType, "forum"));
    expect(audits.map((a) => a.action)).toContain("forum.create");
  });

  it("createForum：父级不存在被拒", async () => {
    const r = await createForum(ACTOR, {
      parentId: 999_999,
      kind: "forum",
      name: "孤儿",
      description: null,
      icon: "",
      sortOrder: 0,
      isListed: true,
    });
    expect(r).toEqual({ ok: false, code: "not_found" });
  });

  it("updateForum：迁移父级重算整棵子树；环被拒", async () => {
    // 区(0) → A → A1；再把 A 迁到 A1 下 = 环
    const a = await createForum(ACTOR, {
      parentId: 0,
      kind: "section",
      name: "A",
      description: null,
      icon: "",
      sortOrder: 0,
      isListed: true,
    });
    if (!a.ok) throw new Error("setup");
    const a1 = await createForum(ACTOR, {
      parentId: a.id,
      kind: "forum",
      name: "A1",
      description: null,
      icon: "",
      sortOrder: 0,
      isListed: true,
    });
    if (!a1.ok) throw new Error("setup");
    const a11 = await createForum(ACTOR, {
      parentId: a1.id,
      kind: "forum",
      name: "A11",
      description: null,
      icon: "",
      sortOrder: 0,
      isListed: true,
    });
    if (!a11.ok) throw new Error("setup");

    const cycle = await updateForum(ACTOR, a.id, {
      parentId: a11.id,
      name: "A",
      description: null,
      icon: "",
      sortOrder: 0,
      isListed: true,
      readPolicy: "inherit",
      writePolicy: "inherit",
      reviewPolicy: "inherit",
      isArchived: false,
    });
    expect(cycle).toEqual({ ok: false, code: "cycle" });

    // A1（含 A11）迁到 A 的兄弟位置：新建 B 分区后迁入
    const b = await createForum(ACTOR, {
      parentId: 0,
      kind: "section",
      name: "B",
      description: null,
      icon: "",
      sortOrder: 0,
      isListed: true,
    });
    if (!b.ok) throw new Error("setup");
    const moved = await updateForum(ACTOR, a1.id, {
      parentId: b.id,
      name: "A1",
      description: null,
      icon: "",
      sortOrder: 0,
      isListed: true,
      readPolicy: "members",
      writePolicy: "inherit",
      reviewPolicy: "threads",
      isArchived: true,
    });
    expect(moved).toEqual({ ok: true });

    const db = getWebDb();
    const [a1row] = await db.select().from(forums).where(eq(forums.id, a1.id));
    const [a11row] = await db.select().from(forums).where(eq(forums.id, a11.id));
    expect(a1row.path).toBe(`/${b.id}/${a1.id}/`);
    expect(a1row.readPolicy).toBe("members");
    expect(a1row.isArchived).toBe(true);
    expect(a11row.path).toBe(`/${b.id}/${a1.id}/${a11.id}/`);
    expect(a11row.depth).toBe(3);

    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, String(a1.id)));
    expect(audits.some((x) => x.action === "forum.update")).toBe(true);
  });

  it("deleteForum：删除保护与空版块删除（含前缀清理）", async () => {
    const parent = await createForum(ACTOR, {
      parentId: 0,
      kind: "section",
      name: "删测父",
      description: null,
      icon: "",
      sortOrder: 0,
      isListed: true,
    });
    if (!parent.ok) throw new Error("setup");
    const child = await createForum(ACTOR, {
      parentId: parent.id,
      kind: "forum",
      name: "删测子",
      description: null,
      icon: "",
      sortOrder: 0,
      isListed: true,
    });
    if (!child.ok) throw new Error("setup");

    // 父有子级 → 拒绝
    expect(await deleteForum(ACTOR, parent.id)).toEqual({ ok: false, code: "has_children" });

    // 子版块挂上前缀 + 伪造主题计数 → has_threads
    expect(await addPrefix(ACTOR, child.id, { name: "测试前缀", sortOrder: 0 })).toEqual({
      ok: true,
    });
    const db = getWebDb();
    await db.update(forums).set({ threadCount: 3 }).where(eq(forums.id, child.id));
    expect(await deleteForum(ACTOR, child.id)).toEqual({ ok: false, code: "has_threads" });

    // 清零计数后可删，前缀一并清理
    await db.update(forums).set({ threadCount: 0 }).where(eq(forums.id, child.id));
    expect(await deleteForum(ACTOR, child.id)).toEqual({ ok: true });
    expect(await listPrefixes(child.id)).toHaveLength(0);
    expect(await deleteForum(ACTOR, child.id)).toEqual({ ok: false, code: "not_found" });

    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, String(child.id)));
    expect(audits.map((x) => x.action)).toEqual(
      expect.arrayContaining(["forum.prefix.add", "forum.delete"]),
    );
  });

  it("removePrefix：不存在的行被拒", async () => {
    expect(await removePrefix(ACTOR, 4_000_000, 1)).toEqual({ ok: false, code: "not_found" });
  });
});
