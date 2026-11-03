// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql-proxy";
import { attachments, postGates, posts, threads } from "@funwind/db";
import { checkPermission } from "@/lib/authz/service";
import { loadSubject } from "@/lib/authz/subject";
import { GUEST_SUBJECT } from "@/lib/authz/types";
import { buildViewerScope, visiblePredicate, type ViewerScope } from "@/lib/queries/visibility";
import { openGateIds } from "./service";
import { listAttachments, listEditableAttachments, resolveFileGrant } from "./attachments";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@funwind/db", async (original) => ({
  ...(await original<typeof import("@funwind/db")>()),
  getWebDb: mocks.getDb,
}));
vi.mock("@/lib/authz/service", () => ({ checkPermission: vi.fn() }));
vi.mock("@/lib/authz/subject", () => ({ loadSubject: vi.fn() }));
vi.mock("@/lib/queries/visibility", async (original) => ({
  ...(await original<typeof import("@/lib/queries/visibility")>()),
  buildViewerScope: vi.fn(),
}));
vi.mock("./service", () => ({ openGateIds: vi.fn() }));

const dialect = new MySqlDialect();
const viewer = { ...GUEST_SUBJECT, userId: 7 };
const viewerScope: ViewerScope = { userId: 7, readable: [901, 902], moderated: [902] };
const guestScope: ViewerScope = { userId: null, readable: [901], moderated: [] };
const thread = { id: 73, forumId: 901 };
const postList = [{ id: 57, authorId: 9 }];

/** 通过真实查询构造器捕获 SQL，只替换执行结果，不连接数据库。 */
function queries(results: unknown[][][]) {
  const pending = [...results];
  const execute = vi.fn(async (_sql: string, _params: unknown[], _method: "all" | "execute") => {
    const rows = pending.shift();
    if (rows === undefined) throw new Error("出现未预期的附件查询");
    return { rows };
  });
  mocks.getDb.mockReturnValue(drizzle(execute));
  return execute;
}

function compile(expression: SQL) {
  const result = dialect.sqlToQuery(expression);
  return { sql: result.sql, params: result.params };
}

/** 与改动前的双表可见性契约逐项对照，避免漏掉帖子状态或复用错误观众。 */
function originalVisibility(scope: ViewerScope) {
  return [
    visiblePredicate(
      { forumId: threads.forumId, state: threads.state, authorId: threads.authorId },
      scope,
    ),
    visiblePredicate(
      { forumId: threads.forumId, state: posts.state, authorId: posts.authorId },
      scope,
    ),
  ];
}

function normalizedSql(text: string) {
  return text.replace(/[()]/g, "").replace(/\s+/g, " ").trim();
}

function expectWhere(query: [string, unknown[], "all" | "execute"], expected: SQL, suffix: string) {
  const expression = compile(expected);
  expect(normalizedSql(query[0].split(" where ")[1]!.split(suffix)[0]!)).toBe(
    normalizedSql(expression.sql),
  );
  expect(query[1]).toEqual([...expression.params, ...(suffix === " limit " ? [1] : [])]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSubject).mockResolvedValue(GUEST_SUBJECT);
  vi.mocked(buildViewerScope).mockImplementation(async (subject) =>
    subject.userId === null ? guestScope : viewerScope,
  );
  vi.mocked(checkPermission).mockResolvedValue({ allowed: true, reason: "granted" });
  vi.mocked(openGateIds).mockResolvedValue(new Set());
});

describe("附件查询内部表达式", () => {
  it("列表与编辑查询都按门控 id 和帖子 id 联结，读取列与链式顺序保持原样", async () => {
    const execute = queries([[], []]);
    expect(await listAttachments(viewer, thread, postList)).toEqual(new Map());
    expect(await listEditableAttachments(57)).toEqual([]);
    const join = compile(
      and(eq(postGates.id, attachments.gateId), eq(postGates.postId, attachments.postId))!,
    ).sql;
    for (const [query] of execute.mock.calls) {
      expect(query).toContain(`left join \`post_gates\` on ${join}`);
      expect(query).not.toContain("hidden_md");
      expect(query).toMatch(
        /from `attachments` inner join `files` .* left join `post_gates` .* where .* order by `attachments`.`id` asc$/,
      );
    }
    expect(execute.mock.calls[0]![0].split(" from ")[0]).toBe(
      "select `attachments`.`id`, `attachments`.`post_id`, `attachments`.`gate_id`, `post_gates`.`gate_key`, `attachments`.`original_name`, `attachments`.`downloads`, `files`.`storage_key`, `files`.`mime`, `files`.`size_bytes`",
    );
    expect(execute.mock.calls[1]![0].split(" from ")[0]).toBe(
      "select `attachments`.`id`, `attachments`.`file_id`, `attachments`.`original_name`, `files`.`mime`, `files`.`storage_key`, `files`.`size_bytes`, `post_gates`.`gate_key`",
    );
    expect(execute.mock.calls.map(([, params]) => params)).toEqual([
      [57, "download"],
      [57, "download"],
    ]);
    expect(openGateIds).toHaveBeenCalledExactlyOnceWith(viewer, thread, postList, new Set());
  });

  it("跨帖或悬空门控即使 id 已开放仍锁定，锁定项没有文件元数据", async () => {
    queries([
      [
        [1, 57, 81, null, "私有文件.zip", 12, "private/key.zip", "application/zip", 90],
        [2, 57, 82, "gate-b", "开放文件.zip", 3, "open/key.zip", "application/zip", 20],
      ],
    ]);
    vi.mocked(openGateIds).mockResolvedValue(new Set([81, 82]));
    const result = (await listAttachments(viewer, thread, postList)).get(57)!;
    expect(result[0]).toEqual({ status: "locked", postId: 57, gateKey: null });
    expect(result[1]).toMatchObject({ status: "open", id: 2, originalName: "开放文件.zip" });
    expect(JSON.stringify(result[0])).not.toMatch(
      /storageKey|originalName|sizeBytes|downloads|私有文件/,
    );
  });

  it("公开图片快路径同时使用游客和当前观众的主题与帖子可见性，保留无门控要求", async () => {
    const execute = queries([[[1]], [[2]]]);
    expect(await resolveFileGrant(viewer, { id: 11, isImage: true })).toEqual({ kind: "public" });
    const expected = and(
      eq(attachments.fileId, 11),
      isNull(attachments.gateId),
      ...originalVisibility(guestScope),
      ...originalVisibility(viewerScope),
    )!;
    expectWhere(execute.mock.calls[1]!, expected, " limit ");
    expect(execute.mock.calls[1]![0]).toContain(
      "from `attachments` inner join `posts` on `posts`.`id` = `attachments`.`post_id` inner join `threads` on `threads`.`id` = `posts`.`thread_id`",
    );
    expect(loadSubject).toHaveBeenCalledExactlyOnceWith(null);
    expect(vi.mocked(buildViewerScope).mock.calls).toEqual([[viewer], [GUEST_SUBJECT]]);
    expect(checkPermission).not.toHaveBeenCalled();
    expect(openGateIds).not.toHaveBeenCalled();
  });

  it("图片无公开引用时再按当前观众查候选，不把游客范围带进私有放行", async () => {
    const execute = queries([[[1]], [], [[21, "图.png", 81, 57, 9, 73, 901]]]);
    vi.mocked(openGateIds).mockResolvedValue(new Set([81]));
    expect(await resolveFileGrant(viewer, { id: 11, isImage: true })).toEqual({
      kind: "granted",
      attachmentId: 21,
      originalName: "图.png",
      gated: true,
    });
    expectWhere(
      execute.mock.calls[2]!,
      and(eq(attachments.fileId, 11), ...originalVisibility(viewerScope))!,
      " order by ",
    );
    expect(execute.mock.calls[2]![0]).toMatch(/order by `attachments`.`id`$/);
    expect(checkPermission).not.toHaveBeenCalled();
    expect(openGateIds).toHaveBeenCalledExactlyOnceWith(viewer, thread, postList, new Set([81]));
  });

  it("非图片先检查下载权限，再检查门控；同版块权限结果只计算一次", async () => {
    const execute = queries([
      [
        [21, "拒绝.zip", 81, 57, 9, 73, 901],
        [22, "仍拒绝.zip", null, 58, 9, 73, 901],
        [23, "可下载.zip", 82, 59, 9, 74, 902],
      ],
    ]);
    vi.mocked(checkPermission)
      .mockResolvedValueOnce({ allowed: false, reason: "denied" })
      .mockResolvedValueOnce({ allowed: true, reason: "granted" });
    vi.mocked(openGateIds).mockResolvedValue(new Set([82]));
    expect(await resolveFileGrant(viewer, { id: 11, isImage: false })).toEqual({
      kind: "granted",
      attachmentId: 23,
      originalName: "可下载.zip",
      gated: true,
    });
    expectWhere(
      execute.mock.calls[0]!,
      and(eq(attachments.fileId, 11), ...originalVisibility(viewerScope))!,
      " order by ",
    );
    expect(vi.mocked(checkPermission).mock.calls).toEqual([
      [viewer, "attachment.download", { forumId: 901 }],
      [viewer, "attachment.download", { forumId: 902 }],
    ]);
    expect(openGateIds).toHaveBeenCalledExactlyOnceWith(
      viewer,
      { id: 74, forumId: 902 },
      [{ id: 59, authorId: 9 }],
      new Set([82]),
    );
    expect(checkPermission).toHaveBeenCalledBefore(vi.mocked(openGateIds));
    expect(loadSubject).not.toHaveBeenCalled();
  });
});
