import { describe, expect, it } from "vitest";
import type { GateDraft } from "@funwind/content";
import { planGateChanges, type ExistingGate, type GatePermissions } from "./write";

const ALL: GatePermissions = { points: true, reply: true };
const NONE: GatePermissions = { points: false, reply: false };
const ONLY_REPLY: GatePermissions = { points: false, reply: true };

const draft = (key: string, over: Partial<GateDraft> = {}): GateDraft => ({
  key,
  seq: 1,
  conditions: [{ type: "points", price: 10 }],
  matchMode: "all",
  hiddenMd: "隐藏",
  ...over,
});
const existing = (key: string, over: Partial<ExistingGate> = {}): ExistingGate => ({
  id: 1,
  gateKey: key,
  conditions: [{ type: "points", price: 10 }],
  matchMode: "all",
  hasUnlocks: false,
  hasAttachments: false,
  ...over,
});
const code = (r: ReturnType<typeof planGateChanges>) => (r.ok ? "ok" : r.error.code);

describe("新增", () => {
  it("有对应创建权限：points / reply 各自放行", () => {
    const r = planGateChanges(
      [],
      [draft("a1"), draft("a2", { conditions: [{ type: "reply" }] })],
      ALL,
    );
    expect(r.ok && r.plan.inserts.map((d) => d.key)).toEqual(["a1", "a2"]);
  });

  it("缺权限被拒：只有 reply 权限的人不能建 points 门控，反之亦然；没有任何权限的人什么都建不了", () => {
    expect(code(planGateChanges([], [draft("a1")], ONLY_REPLY))).toBe("gate_permission");
    expect(
      code(
        planGateChanges([], [draft("a1", { conditions: [{ type: "reply" }] })], {
          points: true,
          reply: false,
        }),
      ),
    ).toBe("gate_permission");
    expect(code(planGateChanges([], [draft("a1")], NONE))).toBe("gate_permission");
  });

  it("未知条件类型即使有全部权限也建不了（没有对应的创建权限）", () => {
    expect(
      code(planGateChanges([], [draft("a1", { conditions: [{ type: "follow" }] })], ALL)),
    ).toBe("gate_permission");
  });

  it("出错时给出出错门控的 key，且不含隐藏文本", () => {
    const r = planGateChanges([], [draft("a1", { hiddenMd: "SECRET-XYZ" })], NONE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.gateKey).toBe("a1");
      expect(JSON.stringify(r.error)).not.toContain("SECRET-XYZ");
    }
  });
});

describe("多条件 / 空条件：每个条件都要有权限", () => {
  const both = [{ type: "reply" }, { type: "points", price: 5 }];

  it("新增：只有 reply 权限的人，不能靠把 reply 放在第一位夹带 points 条件（反之亦然）", () => {
    expect(code(planGateChanges([], [draft("a1", { conditions: both })], ONLY_REPLY))).toBe(
      "gate_permission",
    );
    expect(
      code(planGateChanges([], [draft("a1", { conditions: [...both].reverse() })], ONLY_REPLY)),
    ).toBe("gate_permission");
    // 对照：两种权限都有则放行
    expect(code(planGateChanges([], [draft("a1", { conditions: both })], ALL))).toBe("ok");
  });

  it("空条件拒绝（即使有全部权限）；改成空条件同样拒绝", () => {
    expect(code(planGateChanges([], [draft("a1", { conditions: [] })], ALL))).toBe(
      "gate_permission",
    );
    expect(code(planGateChanges([existing("a1")], [draft("a1", { conditions: [] })], ALL))).toBe(
      "gate_permission",
    );
  });

  it("更新：把单条件门控改成多条件，新增的那个条件也要权限", () => {
    const d = draft("a1", { conditions: [{ type: "points", price: 10 }, { type: "reply" }] });
    expect(code(planGateChanges([existing("a1")], [d], { points: true, reply: false }))).toBe(
      "gate_permission",
    );
    expect(code(planGateChanges([existing("a1")], [d], ALL))).toBe("ok");
  });
});

describe("更新（没有解锁记录）", () => {
  it("只改隐藏正文、条件不变：不需要任何创建权限（权限被收回后仍能编辑帖子里别的内容）", () => {
    const r = planGateChanges([existing("a1")], [draft("a1", { hiddenMd: "新内容" })], NONE);
    expect(r.ok && r.plan.updates.map((u) => u.draft.hiddenMd)).toEqual(["新内容"]);
    expect(r.ok && r.plan.inserts).toEqual([]);
  });

  it("条件相同但键顺序不同，视为没变", () => {
    const r = planGateChanges(
      [existing("a1", { conditions: [{ type: "points", price: 10 }] })],
      [draft("a1", { conditions: [{ price: 10, type: "points" }] })],
      NONE,
    );
    expect(r.ok).toBe(true);
  });

  it("改了条件（价格 / 类型 / 匹配模式）：需要新条件对应的权限；有权限放行", () => {
    const changes: Partial<GateDraft>[] = [
      { conditions: [{ type: "points", price: 99 }] },
      { conditions: [{ type: "reply" }] },
      { matchMode: "any" },
    ];
    for (const c of changes) {
      expect(
        code(planGateChanges([existing("a1")], [draft("a1", c)], NONE)),
        JSON.stringify(c),
      ).toBe("gate_permission");
      expect(
        code(planGateChanges([existing("a1")], [draft("a1", c)], ALL)),
        JSON.stringify(c),
      ).toBe("ok");
    }
  });
});

describe("删除", () => {
  it("没有解锁、没有附件：可删除", () => {
    const r = planGateChanges([existing("a1", { id: 7 })], [], NONE);
    expect(r.ok && r.plan.deletes).toEqual([{ id: 7, gateKey: "a1" }]);
  });

  it("已有解锁记录：不可删除（买家付过钱）；对照：同一个门控没有解锁记录就能删", () => {
    expect(code(planGateChanges([existing("a1", { hasUnlocks: true })], [], ALL))).toBe(
      "gate_has_unlocks",
    );
    expect(code(planGateChanges([existing("a1", { hasUnlocks: false })], [], ALL))).toBe("ok");
  });

  it("名下还挂着附件：不可删除（不得让附件悄悄变公开）", () => {
    expect(code(planGateChanges([existing("a1", { hasAttachments: true })], [], ALL))).toBe(
      "gate_has_attachments",
    );
  });

  it("多个门控里只删一个：其余原样保留", () => {
    const r = planGateChanges(
      [existing("a1", { id: 1 }), existing("a2", { id: 2 })],
      [draft("a2")],
      ALL,
    );
    expect(r.ok && r.plan.deletes.map((d) => d.gateKey)).toEqual(["a1"]);
    expect(r.ok && r.plan.updates.map((u) => u.id)).toEqual([2]);
  });
});

describe("已有解锁记录的门控：只能改价格", () => {
  const sold = existing("a1", { hasUnlocks: true });

  it("改价格放行（改价不退款，只影响之后的购买）；仍需 gate.points 权限", () => {
    const d = draft("a1", { conditions: [{ type: "points", price: 50 }] });
    expect(code(planGateChanges([sold], [d], ALL))).toBe("ok");
    expect(code(planGateChanges([sold], [d], NONE))).toBe("gate_permission");
  });

  it("改成别的解锁方式、改匹配模式、加条件：一律拒绝", () => {
    const bad: Partial<GateDraft>[] = [
      { conditions: [{ type: "reply" }] },
      { matchMode: "any" },
      { conditions: [{ type: "points", price: 10 }, { type: "reply" }] },
      { conditions: [{ type: "points", price: 10, extra: 1 }] },
    ];
    for (const c of bad)
      expect(code(planGateChanges([sold], [draft("a1", c)], ALL)), JSON.stringify(c)).toBe(
        "gate_conditions_locked",
      );
  });

  it("只改隐藏正文放行（M6.5 再加「内容已更新」提示）", () => {
    expect(code(planGateChanges([sold], [draft("a1", { hiddenMd: "改了" })], NONE))).toBe("ok");
  });
});
