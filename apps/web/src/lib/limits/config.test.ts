import { DEFAULT_LIMITS } from "@funwind/db";
import { describe, expect, it } from "vitest";
import { ForumTree, type ForumNode } from "@/lib/forums/forum-tree";
import { GUEST_SUBJECT, type Subject } from "@/lib/authz/types";
import {
  DEFAULT_LIMITS_CONFIG,
  applicableRoleKeys,
  limitsConfigSchema,
  parseLimitsConfig,
  resolveLimits,
  type LimitsConfig,
} from "./config";

const cfg = (roles: LimitsConfig["roles"], over: Partial<LimitsConfig> = {}): LimitsConfig => ({
  titleMax: 100,
  bodyMax: 50000,
  roles,
  ...over,
});
const lim = (
  postIntervalSec: number,
  threadsPerDay: number,
  uploadsPerDay: number,
  editWindowSec = 0,
  pmPerDay = 0,
) => ({
  postIntervalSec,
  threadsPerDay,
  uploadsPerDay,
  pmPerDay,
  editWindowSec,
});

describe("默认配置", () => {
  it("packages/db 的默认值能通过 zod 校验，且就是被校验后的值（默认值只有一份）", () => {
    expect(limitsConfigSchema.parse(DEFAULT_LIMITS)).toEqual(DEFAULT_LIMITS_CONFIG);
    expect(DEFAULT_LIMITS_CONFIG.roles["member"]).toEqual(lim(5, 100, 20, 0, 50)); // pmPerDay 默认 50（私信上限）
    expect(DEFAULT_LIMITS_CONFIG.roles["admin"]).toEqual(lim(0, 0, 0, 0, 0));
  });
});

describe("parseLimitsConfig：无效配置整体回落默认值", () => {
  it("缺失 / null → 默认，且不算错误（没配置过是正常的）", () => {
    expect(parseLimitsConfig(undefined)).toEqual({ config: DEFAULT_LIMITS_CONFIG });
    expect(parseLimitsConfig(null)).toEqual({ config: DEFAULT_LIMITS_CONFIG });
  });

  it("editWindowSec 可选：旧配置（不含该字段）仍然有效，缺省为 0（不限）；对照：它给了负数则整体无效", () => {
    const legacy = {
      titleMax: 100,
      bodyMax: 50000,
      roles: { member: { postIntervalSec: 5, threadsPerDay: 100, uploadsPerDay: 20 } },
    };
    const r = parseLimitsConfig(legacy);
    expect(r.error).toBeUndefined();
    expect(r.config.roles["member"]).toEqual(lim(5, 100, 20, 0));
    expect(parseLimitsConfig(cfg({ member: lim(5, 100, 20, -1) })).error).toBeTruthy();
    expect(parseLimitsConfig(cfg({ member: lim(5, 100, 20, 3600) })).error).toBeUndefined();
  });

  it("编辑时限合并：与额度同口径，0 = 不限胜过任何正数", () => {
    const c = cfg({ member: lim(5, 100, 20, 600), team: lim(5, 100, 20, 0) });
    expect(resolveLimits(c, ["member"]).editWindowSec).toBe(600);
    expect(resolveLimits(c, ["member", "team"]).editWindowSec).toBe(0);
  });

  it("合法的自定义配置原样生效（含给团队角色单独配置）", () => {
    const custom = cfg({ member: lim(10, 50, 5), "team-sub": lim(0, 0, 100) }, { titleMax: 80 });
    expect(parseLimitsConfig(custom)).toEqual({ config: custom });
  });

  it("各种写坏的形态：回落默认并给出带路径的错误说明", () => {
    const bad: [string, unknown][] = [
      [
        "角色项缺字段（缺省补 0 会悄悄变成不限，所以必须整体无效）",
        cfg({ member: { postIntervalSec: 5 } as never }),
      ],
      // 三个字段各缺一个：任何一个缺省补 0 都会悄悄变成"不限"，所以逐个验证
      ["只缺 postIntervalSec", cfg({ member: { threadsPerDay: 1, uploadsPerDay: 1 } as never })],
      ["只缺 threadsPerDay", cfg({ member: { postIntervalSec: 1, uploadsPerDay: 1 } as never })],
      ["只缺 uploadsPerDay", cfg({ member: { postIntervalSec: 1, threadsPerDay: 1 } as never })],
      ["多出未知字段（strict）", { ...cfg({ member: lim(5, 1, 1) }), extra: 1 }],
      ["负数", cfg({ member: lim(-1, 1, 1) })],
      ["小数", cfg({ member: lim(1.5, 1, 1) })],
      ["字符串数字", cfg({ member: lim("5" as never, 1, 1) })],
      ["titleMax 为 0", cfg({ member: lim(5, 1, 1) }, { titleMax: 0 })],
      ["titleMax 超过列宽 255", cfg({ member: lim(5, 1, 1) }, { titleMax: 256 })],
      ["bodyMax 过大", cfg({ member: lim(5, 1, 1) }, { bodyMax: 2_000_000 })],
      ["间隔超过一小时", cfg({ member: lim(3601, 1, 1) })],
      ["角色键不是 kebab-case", cfg({ Member: lim(5, 1, 1) })],
      ["角色键含下划线", cfg({ team_sub: lim(5, 1, 1) })],
      ["roles 不是对象", { titleMax: 100, bodyMax: 1000, roles: [] }],
      ["整体是字符串", "unlimited"],
      ["整体是数组", []],
    ];
    for (const [name, v] of bad) {
      const r = parseLimitsConfig(v);
      expect(r.config, name).toEqual(DEFAULT_LIMITS_CONFIG);
      expect(r.error, name).toBeTruthy();
    }
    expect(parseLimitsConfig(cfg({ member: lim(-1, 1, 1) })).error).toContain(
      "roles.member.postIntervalSec",
    );
  });
});

describe("resolveLimits：每项取最宽松的值，0 = 不限", () => {
  const config = cfg(
    {
      member: lim(5, 100, 20),
      admin: lim(0, 0, 0),
      "team-a": lim(10, 300, 50),
      slow: lim(30, 10, 2),
    },
    { titleMax: 90, bodyMax: 40000 },
  );

  it("单个角色：原样返回；标题 / 正文上限是全局项，直接带上", () => {
    expect(resolveLimits(config, ["member"])).toEqual({
      titleMax: 90,
      bodyMax: 40000,
      postIntervalSec: 5,
      threadsPerDay: 100,
      uploadsPerDay: 20,
      editWindowSec: 0,
      pmPerDay: 0,
    });
  });

  it("间隔取最小（越短越宽松），额度取最大——会员 + 额度更高的团队角色", () => {
    const r = resolveLimits(config, ["member", "team-a"]);
    expect(r.postIntervalSec).toBe(5);
    expect(r.threadsPerDay).toBe(300);
    expect(r.uploadsPerDay).toBe(50);
  });

  it("0 = 不限，胜过任何正数（不能被 Math.max 误吞）：会员 + admin → 额度为 0（不限）", () => {
    const r = resolveLimits(config, ["member", "admin"]);
    expect(r).toMatchObject({ postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 0 });
    // 对照：朴素的 Math.max 会得到 100 / 20，被限制住——这正是要避免的 bug
    expect(Math.max(100, 0)).toBe(100);
  });

  it("间隔里的 0（无间隔限制）同样最宽松", () => {
    expect(
      resolveLimits(cfg({ a: lim(0, 5, 5), b: lim(10, 5, 5) }), ["a", "b"]).postIntervalSec,
    ).toBe(0);
  });

  it("较严的角色不会拖累已有的宽松角色（取最宽松，而不是最严）", () => {
    const r = resolveLimits(config, ["member", "slow"]);
    expect(r).toMatchObject({ postIntervalSec: 5, threadsPerDay: 100, uploadsPerDay: 20 });
  });

  it("配置里没有的角色（如未配置的团队角色）不参与取值，按已配置的角色算", () => {
    expect(resolveLimits(config, ["member", "team-unconfigured"])).toEqual(
      resolveLimits(config, ["member"]),
    );
  });

  it("没有任何角色匹配（游客）→ 回落到 member 项，绝不变成不限", () => {
    const r = resolveLimits(config, []);
    expect(r).toMatchObject({ postIntervalSec: 5, threadsPerDay: 100, uploadsPerDay: 20 });
    expect(resolveLimits(config, ["nobody"])).toMatchObject({ threadsPerDay: 100 });
  });

  it("配置里连 member 项都没有：用默认的 member 项兜底，仍不变成不限", () => {
    const noMember = cfg({ admin: lim(0, 0, 0) });
    expect(resolveLimits(noMember, [])).toMatchObject({
      postIntervalSec: 5,
      threadsPerDay: 100,
      uploadsPerDay: 20,
    });
    expect(resolveLimits(noMember, ["unknown"]).threadsPerDay).toBe(100);
  });
});

describe("applicableRoleKeys：版块作用域", () => {
  const node = (id: number, parentId: number, path: string): ForumNode => ({
    id,
    parentId,
    path,
    depth: path.split("/").length - 2,
    kind: "forum",
    name: `版块${id}`,
    description: null,
    icon: "",
    sortOrder: id,
    readPolicy: "inherit",
    writePolicy: "inherit",
    reviewPolicy: "inherit",
    isListed: true,
    isArchived: false,
  });
  const tree = new ForumTree([node(1, 0, "/1/"), node(2, 1, "/1/2/"), node(3, 0, "/3/")]);
  const subject = (roles: Subject["roles"]): Subject => ({ ...GUEST_SUBJECT, userId: 1, roles });

  it("全局绑定恒适用；版块作用域的绑定只在该版块（含子树）内适用", () => {
    const s = subject([
      { key: "member", scopeId: 0 },
      { key: "team", scopeId: 1 },
    ]);
    expect(applicableRoleKeys(s, tree, 2).sort()).toEqual(["member", "team"]); // 2 在 1 的子树内
    expect(applicableRoleKeys(s, tree, 1).sort()).toEqual(["member", "team"]);
    expect(applicableRoleKeys(s, tree, 3)).toEqual(["member"]); // 3 不在 1 的子树内
  });

  it("站点级（不给 forumId）只取全局绑定；重复的角色键去重", () => {
    const s = subject([
      { key: "member", scopeId: 0 },
      { key: "team", scopeId: 1 },
      { key: "member", scopeId: 1 },
    ]);
    expect(applicableRoleKeys(s, tree)).toEqual(["member"]);
    expect(applicableRoleKeys(s, tree, 2)).toEqual(["member", "team"]);
  });

  it("端到端：作用域内的宽松团队角色只在其版块里放宽限制", () => {
    const config = cfg({ member: lim(5, 100, 20), team: lim(0, 0, 0) });
    const s = subject([
      { key: "member", scopeId: 0 },
      { key: "team", scopeId: 1 },
    ]);
    expect(resolveLimits(config, applicableRoleKeys(s, tree, 2)).threadsPerDay).toBe(0);
    expect(resolveLimits(config, applicableRoleKeys(s, tree, 3)).threadsPerDay).toBe(100);
  });
});
