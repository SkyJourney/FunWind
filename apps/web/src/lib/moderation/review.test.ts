// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forums, getWebDb, posts, threads, userStats } from "@funwind/db";
import type { DbTx } from "@/lib/audit";
import { checkPermission } from "@/lib/authz/service";
import { loadFreshAuthzSnapshot } from "@/lib/authz/snapshot";
import { loadSubjectFrom } from "@/lib/authz/subject";
import type { AuthzSnapshot, Subject } from "@/lib/authz/types";
import { nowBeijingWallTime } from "@/lib/datetime";
import { dispatchOutboxRows, enqueueEventInTx, sweepPending } from "@/lib/events/outbox";
import { POINTS_TX_OPTIONS } from "@/lib/points/retry";
import { lockThread } from "@/lib/posting/locks";
import { transitionContent } from "@/lib/posting/transition";
import { approveReview, disableContent, hidePost, prepareApiReview, rejectReview } from "./review";

vi.mock("@funwind/db", async (original) => ({
  ...(await original<typeof import("@funwind/db")>()),
  getWebDb: vi.fn(),
}));
vi.mock("@/lib/authz/service", () => ({ checkPermission: vi.fn() }));
vi.mock("@/lib/authz/snapshot", () => ({ loadFreshAuthzSnapshot: vi.fn() }));
vi.mock("@/lib/authz/subject", () => ({ loadSubjectFrom: vi.fn() }));
vi.mock("@/lib/posting/transition", () => ({ transitionContent: vi.fn() }));
vi.mock("@/lib/locks", () => ({ lockUserStats: vi.fn() }));
vi.mock("@/lib/posting/locks", () => ({
  lockThread: vi.fn(async () => ({ forumId: 6 })),
  lockForum: vi.fn(),
}));
vi.mock("@/lib/events/outbox", () => ({
  enqueueEventInTx: vi.fn(),
  dispatchOutboxRows: vi.fn(),
  sweepPending: vi.fn(),
}));
vi.mock("@/lib/datetime", () => ({ nowBeijingWallTime: vi.fn(() => "2026-10-31 12:34:56") }));

const operator: Subject = {
  userId: 2,
  roles: [],
  restrictions: [],
  emailVerified: true,
  emailVerificationRequired: false,
  registerMode: "invite",
};
const actor = { userId: 2, via: "admin" as const, ip: "127.0.0.1" };
const freshSnapshot = { tree: { has: () => true } } as unknown as AuthzSnapshot;
const context = {
  postId: 3,
  postState: "pending",
  authorId: 4,
  threadId: 5,
  forumId: 6,
  title: "待审主题",
};
const actions = [
  {
    name: "approve",
    state: "pending",
    to: "visible",
    decision: "approved",
    run: (who = operator, reason = "理由") => {
      void reason;
      return approveReview(who, 3, actor);
    },
  },
  {
    name: "reject",
    state: "pending",
    to: "rejected",
    decision: "rejected",
    run: (who = operator, reason = "理由") => rejectReview(who, 3, reason, actor),
  },
  {
    name: "hide",
    state: "visible",
    to: "hidden",
    decision: null,
    run: (who = operator, reason = "理由") => hidePost(who, 3, reason, actor),
  },
  {
    name: "disable",
    state: "visible",
    to: "disabled",
    decision: "disabled",
    run: (who = operator, reason = "理由") => disableContent(who, 3, reason, actor),
  },
];
const reasonActions = actions.filter((action) => action.name !== "approve");
const limit = vi.fn();
const values = vi.fn();
const lockedPost = vi.fn();
const lockedStats = vi.fn();
const lockedForum = vi.fn();
const tx = {
  insert: vi.fn(() => ({ values })),
  select: vi.fn(() => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => (table === threads ? [{ title: context.title }] : [{ authorId: 8 }]),
        for: () => {
          if (table === posts) return lockedPost();
          if (table === userStats) return lockedStats();
          if (table === forums) return lockedForum();
          throw new Error("意外的锁读表");
        },
      }),
    }),
  })),
};
const transaction = vi.fn();
const select = vi.fn(() => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit }) }) }) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWebDb).mockReturnValue({ select, transaction } as unknown as ReturnType<
    typeof getWebDb
  >);
  limit.mockResolvedValue([{ ...context }]);
  lockedPost.mockImplementation(async () => [
    {
      threadId: context.threadId,
      authorId: context.authorId,
      state: (await limit())[0]?.postState,
      editedAt: null,
      replyToPostId: null,
    },
  ]);
  lockedStats.mockResolvedValue([{ userId: context.authorId }]);
  lockedForum.mockResolvedValue([{ id: context.forumId }]);
  values.mockResolvedValue(undefined);
  transaction.mockImplementation(async (fn) => fn(tx));
  vi.mocked(checkPermission).mockResolvedValue({ allowed: true, reason: "允许" });
  vi.mocked(loadSubjectFrom).mockResolvedValue(operator);
  vi.mocked(loadFreshAuthzSnapshot).mockResolvedValue(freshSnapshot);
  vi.mocked(transitionContent).mockResolvedValue({
    ok: true,
    changed: true,
    kind: "thread",
    from: "pending",
    to: "visible",
    postId: 3,
    floor: 1,
    threadId: 5,
    forumId: 6,
    authorId: 4,
    threadAuthorId: 4,
  });
  let id = 0;
  vi.mocked(enqueueEventInTx).mockImplementation(async (_tx, name, payload, opts = {}) => ({
    id: ++id,
    name,
    payload,
    actorId: opts.actorId ?? null,
    source: opts.source ?? null,
  }));
});

function expectNoWrite() {
  expect(transaction).not.toHaveBeenCalled();
  expect(enqueueEventInTx).not.toHaveBeenCalled();
  expect(dispatchOutboxRows).not.toHaveBeenCalled();
  expect(sweepPending).not.toHaveBeenCalled();
}

describe.each(actions)("审核错误矩阵：$name", (action) => {
  beforeEach(() => limit.mockResolvedValue([{ ...context, postState: action.state }]));

  it("游客先于存在性和理由校验", async () => {
    expect(await action.run({ ...operator, userId: null }, "")).toEqual({
      ok: false,
      code: "forbidden",
      message: "请先登录",
    });
    expect(select).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("不存在先于权限和理由校验", async () => {
    limit.mockResolvedValue([]);
    expect(await action.run(operator, "")).toEqual({
      ok: false,
      code: "not_found",
      message: "帖子不存在",
    });
    expect(checkPermission).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("越权先于状态和理由校验", async () => {
    limit.mockResolvedValue([{ ...context, postState: "deleted" }]);
    vi.mocked(checkPermission).mockResolvedValue({ allowed: false, reason: "无权" });
    expect(await action.run(operator, "")).toEqual({
      ok: false,
      code: "forbidden",
      message: "你不是该版块的版主",
    });
    expect(checkPermission).toHaveBeenCalledWith(operator, "forum.moderate", { forumId: 6 });
    expectNoWrite();
  });

  it.each(["not_found", "illegal_transition"] as const)(
    "锁内迁移失败 %s 保留动作专属映射",
    async (code) => {
      vi.mocked(transitionContent).mockResolvedValue({ ok: false, code });
      expect(await action.run()).toEqual({
        ok: false,
        code: action.name === "approve" && code === "not_found" ? "not_found" : "bad_state",
        message: "状态迁移失败",
      });
      expect(values).not.toHaveBeenCalled();
      expect(dispatchOutboxRows).not.toHaveBeenCalled();
      expect(sweepPending).not.toHaveBeenCalled();
    },
  );

  it("成功时保持目标状态、同事务审计、审核记录与事件身份", async () => {
    expect(await action.run(operator, "  理由  ")).toEqual({ ok: true });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), POINTS_TX_OPTIONS);
    expect(transitionContent).toHaveBeenCalledWith(tx, 3, action.to, {
      actorId: 2,
      ip: actor.ip,
      audit: true,
      ...(action.name !== "approve" ? { reason: "理由" } : {}),
      ...(action.name === "disable" ? { actor: "moderator" } : {}),
    });
    if (action.decision) {
      expect(values).toHaveBeenCalledWith({
        postId: 3,
        reviewerId: 2,
        decision: action.decision,
        note: action.name === "approve" ? "" : "理由",
        createdAt: nowBeijingWallTime(),
      });
    } else {
      expect(values).not.toHaveBeenCalled();
    }
    const rows = vi.mocked(dispatchOutboxRows).mock.calls[0]![0];
    expect(rows.map((row) => row.name)).toEqual(
      action.name === "approve" ? ["thread.created", "content.moderated"] : ["content.moderated"],
    );
    expect(rows.at(-1)).toMatchObject({
      actorId: 2,
      source: "moderation",
      payload: {
        postId: 3,
        operatorId: 2,
        action: action.name,
        ...(action.name !== "approve" ? { reason: "理由" } : {}),
      },
    });
    expect(sweepPending).toHaveBeenCalledOnce();
  });
});

describe("状态校验先于理由，保持四动作状态限制", () => {
  it.each(
    actions.flatMap((action) =>
      ["visible", "pending", "rejected", "hidden", "deleted", "disabled"]
        .filter((state) =>
          action.name === "disable"
            ? ["deleted", "disabled"].includes(state)
            : state !== action.state,
        )
        .map((state) => ({ ...action, rejectedState: state })),
    ),
  )("$name 拒绝 $rejectedState", async (action) => {
    limit.mockResolvedValue([{ ...context, postState: action.rejectedState }]);
    const message =
      action.name === "disable"
        ? action.rejectedState === "disabled"
          ? "该内容已被封禁"
          : "已删除内容不能封禁"
        : `当前状态是 ${action.rejectedState}，只有${action.name === "hide" ? "可见内容可以屏蔽" : action.name === "approve" ? "待审内容可以通过" : "待审内容可以驳回"}`;
    expect(await action.run(operator, "")).toEqual({ ok: false, code: "bad_state", message });
    expectNoWrite();
  });

  it.each(reasonActions)("$name 拒绝空白和超长理由，255 字边界允许", async (action) => {
    limit.mockResolvedValue([{ ...context, postState: action.state }]);
    expect(await action.run(operator, "  ")).toEqual({
      ok: false,
      code: "reason_required",
      message: "必须填写理由",
    });
    expect(await action.run(operator, "字".repeat(256))).toEqual({
      ok: false,
      code: "reason_too_long",
      message: "理由太长（≤255 字）",
    });
    expectNoWrite();
    expect(await action.run(operator, ` ${"字".repeat(255)} `)).toEqual({ ok: true });
  });

  it.each(["visible", "pending", "rejected", "hidden"])("封禁接受 %s", async (state) => {
    limit.mockResolvedValue([{ ...context, postState: state }]);
    expect(await disableContent(operator, 3, "理由", actor)).toEqual({ ok: true });
  });
});

it("通过回帖时补发 thread.replied，积分事件归作者而审核事件归版主", async () => {
  vi.mocked(transitionContent).mockResolvedValue({
    ok: true,
    changed: true,
    kind: "reply",
    from: "pending",
    to: "visible",
    postId: 3,
    floor: 2,
    threadId: 5,
    forumId: 6,
    authorId: 4,
    threadAuthorId: 8,
  });
  expect(await approveReview(operator, 3, actor)).toEqual({ ok: true });
  expect(dispatchOutboxRows).toHaveBeenCalledWith([
    expect.objectContaining({
      name: "thread.replied",
      actorId: 4,
      payload: { threadId: 5, postId: 3, forumId: 6, authorId: 4, threadAuthorId: 8 },
    }),
    expect.objectContaining({ name: "content.moderated", actorId: 2 }),
  ]);
});

describe("管理 API 审核事务适配器", () => {
  const trace = { requestId: "审核请求", tokenSuffix: "tail0001" };
  const input = { decision: "approve", expectedEditedAt: null } as const;
  const apiActor = { ...actor, via: "api" as const };

  async function prepare() {
    const result = await prepareApiReview(operator, context.postId, input, apiActor, trace);
    if (!result.ok) throw new Error(result.code);
    return result;
  }

  it("目标权限否决与目标不存在相同", async () => {
    vi.mocked(checkPermission).mockResolvedValue({ allowed: false, reason: "无权" });
    const denied = await prepareApiReview(operator, context.postId, input, apiActor, trace);
    limit.mockResolvedValue([]);
    const missing = await prepareApiReview(operator, context.postId, input, apiActor, trace);
    expect(denied).toEqual(missing);
    expect(denied).toMatchObject({ ok: false, code: "not_found" });
    expectNoWrite();
  });

  it("移版后失败且不从事务内重新鉴权", async () => {
    const prepared = await prepare();
    vi.mocked(lockThread).mockResolvedValueOnce({ forumId: 7 } as never);
    expect(await prepared.lock(tx as unknown as DbTx)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(checkPermission).toHaveBeenCalledOnce();
    expect(getWebDb).toHaveBeenCalledOnce();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(transitionContent).not.toHaveBeenCalled();
  });

  it.each([
    { state: "visible", editedAt: null, code: "bad_state" },
    { state: "pending", editedAt: "2026-11-18 12:00:00", code: "conflict" },
  ])("$code 只在执行阶段否决，因此不阻止已提交回放", async ({ state, editedAt, code }) => {
    limit.mockResolvedValue([{ ...context, postState: state }]);
    lockedPost.mockResolvedValue([{ ...context, state, editedAt, replyToPostId: null }]);
    const prepared = await prepare();
    const locked = await prepared.lock(tx as unknown as DbTx);
    if (!locked.ok) throw new Error(locked.code);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(await locked.execute()).toMatchObject({ ok: false, code });
    expect(transitionContent).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("统计缺行不在回放锁阶段补写，真实执行才报错", async () => {
    lockedStats.mockResolvedValue([]);
    const prepared = await prepare();
    const locked = await prepared.lock(tx as unknown as DbTx);
    if (!locked.ok) throw new Error(locked.code);
    expect(tx.insert).not.toHaveBeenCalled();
    await expect(locked.execute()).rejects.toThrow("缺少统计行");
    expect(transitionContent).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each(["hide", "disable"] as const)(
    "%s 在事务外先拒空白与超长理由，255 字边界允许",
    async (decision) => {
      limit.mockResolvedValue([{ ...context, postState: "visible" }]);
      const blank = await prepareApiReview(
        operator,
        context.postId,
        { decision, expectedEditedAt: null, reason: "  " },
        apiActor,
        trace,
      );
      expect(blank).toMatchObject({ ok: false, code: "reason_required" });
      const long = await prepareApiReview(
        operator,
        context.postId,
        { decision, expectedEditedAt: null, reason: "字".repeat(256) },
        apiActor,
        trace,
      );
      expect(long).toMatchObject({ ok: false, code: "reason_too_long" });
      expectNoWrite();
      const prepared = await prepareApiReview(
        operator,
        context.postId,
        { decision, expectedEditedAt: null, reason: ` ${"字".repeat(255)} ` },
        apiActor,
        trace,
      );
      if (!prepared.ok) throw new Error(prepared.code);
      const locked = await prepared.lock(tx as unknown as DbTx);
      if (!locked.ok) throw new Error(locked.code);
      const execution = await locked.execute();
      if (!execution.ok) throw new Error(execution.code);
      expect(execution.data).toEqual({
        postId: 3,
        threadId: 5,
        state: decision === "hide" ? "hidden" : "disabled",
      });
    },
  );

  it("使用调用方事务和原事件快派；快派错误留给提交后调用方处理", async () => {
    const prepared = await prepare();
    const locked = await prepared.lock(tx as unknown as DbTx);
    if (!locked.ok) throw new Error(locked.code);
    expect(loadSubjectFrom).toHaveBeenCalledWith(tx, operator.userId, operator.registerMode, true);
    expect(loadFreshAuthzSnapshot).toHaveBeenCalledWith(tx, {
      lockedForum: { id: context.forumId },
      roleKeys: [],
    });
    expect(checkPermission).toHaveBeenLastCalledWith(
      operator,
      "forum.moderate",
      { forumId: 6 },
      freshSnapshot,
    );
    expect(getWebDb).toHaveBeenCalledOnce();
    expect(tx.insert).not.toHaveBeenCalled();
    const execution = await locked.execute();
    if (!execution.ok) throw new Error(execution.code);
    expect(execution.data).toEqual({ postId: 3, threadId: 5, state: "visible" });
    expect(transitionContent).toHaveBeenCalledWith(tx, 3, "visible", {
      actorId: operator.userId,
      ip: actor.ip,
      audit: true,
      apiTrace: trace,
    });
    expect(dispatchOutboxRows).not.toHaveBeenCalled();
    vi.mocked(dispatchOutboxRows).mockRejectedValueOnce(new Error("快派失败"));
    await expect(execution.afterCommit?.()).rejects.toThrow("快派失败");
    expect(dispatchOutboxRows).toHaveBeenCalledWith([
      expect.objectContaining({ name: "thread.created" }),
      expect.objectContaining({ name: "content.moderated" }),
    ]);
  });
});
