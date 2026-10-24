import { PERMISSION_DEFINITIONS } from "@funwind/db";
import { describe, expect, it } from "vitest";
import { translateGlobalGrants, translateUserRoles, type OldPermRow } from "./authz.js";

const ASOF = "2026-10-23 00:00:00";
const unix = (s: string) => Math.floor(new Date(`${s.replace(" ", "T")}+08:00`).getTime() / 1000);
const p = (gid: number, rkey: string, rvalue: string): OldPermRow => ({ gid, rkey, rvalue });
const has = (r: ReturnType<typeof translateGlobalGrants>, role: string, perm: string) =>
  r.grants.some((g) => g.roleKey === role && g.permissionKey === perm);

describe("translateGlobalGrants", () => {
  it("标量值：1 开启、0 关闭；旧键经 legacy_key 映射为新权限点", () => {
    const r = translateGlobalGrants([
      p(8, "allow_post", "1"),
      p(8, "allow_upload", "0"),
      p(8, "allow_visit", "1"),
    ]);
    expect(has(r, "member", "forum.write")).toBe(true);
    expect(has(r, "member", "site.visit")).toBe(true);
    expect(has(r, "member", "attachment.upload")).toBe(false);
  });

  it("allow_reply 也折叠为 forum.write（发帖/回复在新模型里统一）", () => {
    const r = translateGlobalGrants([p(18, "allow_reply", "1")]);
    expect(has(r, "team-subtitle", "forum.write")).toBe(true);
  });

  it("allow_thread_extend 数组：sell → gate.points，hide → gate.reply，互相独立", () => {
    const both = translateGlobalGrants([
      p(8, "allow_thread_extend", 'a:2:{s:4:"sell";s:1:"1";s:4:"hide";s:1:"1";}'),
    ]);
    expect(has(both, "member", "gate.points")).toBe(true);
    expect(has(both, "member", "gate.reply")).toBe(true);
    const hideOnly = translateGlobalGrants([
      p(18, "allow_thread_extend", 'a:1:{s:4:"hide";s:1:"1";}'),
    ]);
    expect(has(hideOnly, "team-subtitle", "gate.reply")).toBe(true);
    expect(has(hideOnly, "team-subtitle", "gate.points")).toBe(false);
    const sellOff = translateGlobalGrants([
      p(8, "allow_thread_extend", 'a:2:{s:4:"sell";s:1:"0";s:4:"hide";s:1:"1";}'),
    ]);
    expect(has(sellOff, "member", "gate.points")).toBe(false);
  });

  it("后台面板键（序列化数组）：任一子项为真即开启；全 0 则不开", () => {
    const r = translateGlobalGrants([
      p(3, "panel_user_manage", 'a:1:{s:10:"user_check";s:1:"1";}'),
      p(18, "panel_log_manage", 'a:1:{s:3:"log";s:1:"0";}'),
    ]);
    expect(has(r, "admin", "admin.users")).toBe(true);
    expect(has(r, "team-subtitle", "admin.logs")).toBe(false);
  });

  it("v1 脏键回归：不会产生 p1 / p2 / y 之类词汇表外的权限点或角色", () => {
    const r = translateGlobalGrants([
      p(3, "panel_bbs_manage", 'a:3:{s:2:"p1";s:1:"1";s:2:"p2";s:1:"1";s:1:"y";s:1:"1";}'),
      p(8, "operate_thread", 'a:2:{s:1:"a";s:1:"1";s:1:"x";s:1:"1";}'),
    ]);
    const known = new Set(PERMISSION_DEFINITIONS.map((d) => d.key));
    for (const g of r.grants) expect(known.has(g.permissionKey), g.permissionKey).toBe(true);
    for (const g of r.grants) expect(["p1", "p2", "y", "a", "x"]).not.toContain(g.roleKey);
  });

  it("提权回归：operate_thread 对普通会员只是设置数组，绝不能翻译成全局版主权限", () => {
    const r = translateGlobalGrants([
      p(8, "operate_thread", 'a:2:{s:7:"up_time";i:72;s:11:"topped_type";s:1:"0";}'),
      p(18, "operate_thread", 'a:2:{s:7:"up_time";i:72;s:11:"topped_type";s:1:"0";}'),
      p(3, "operate_thread", 'a:2:{s:6:"digest";s:1:"1";s:4:"move";s:1:"1";}'),
    ]);
    expect(
      r.grants.filter((g) => g.permissionKey === "forum.moderate" && g.roleKey !== "admin"),
    ).toEqual([]);
    expect(r.stats.skippedModeration).toBe(3);
  });

  it("非开关键出现数组值（设置而非开关）：不翻译为授权，单独计数", () => {
    const r = translateGlobalGrants([p(8, "allow_post", 'a:1:{s:3:"max";i:5;}')]);
    expect(has(r, "member", "forum.write")).toBe(false);
    expect(r.stats.unexpectedArrays.get("allow_post")).toBe(1);
  });

  it("面板键的开关数组仍然生效", () => {
    const r = translateGlobalGrants([p(3, "panel_report_manage", 'a:1:{s:1:"x";s:1:"1";}')]);
    expect(has(r, "admin", "admin.reports")).toBe(true);
  });

  it("损坏的序列化值计入 parseErrors，不会被当作开启", () => {
    const r = translateGlobalGrants([p(8, "allow_thread_extend", 'a:9:{garbage s:1:"1"}')]);
    expect(r.stats.parseErrors).toEqual([
      { gid: 8, rkey: "allow_thread_extend", value: 'a:9:{garbage s:1:"1"}' },
    ]);
    expect(has(r, "member", "gate.points")).toBe(false);
  });

  it("版块读权限交给 read_policy；条件键与已取消功能的键分别计数", () => {
    const r = translateGlobalGrants([
      p(8, "allow_read", "1"),
      p(8, "threads_perday", "50"),
      p(8, "allow_publish_vedio", "1"),
    ]);
    expect(r.stats.skippedPolicy).toBe(1);
    expect(r.stats.conditionKeys.get("threads_perday")).toBe(1);
    expect(r.stats.unmappedKeys.get("allow_publish_vedio")).toBe(1);
    expect(has(r, "member", "forum.read")).toBe(false);
  });

  it("未映射的 gid（已删除组）与禁止发言组被跳过并计数", () => {
    const r = translateGlobalGrants([
      p(25, "allow_post", "1"),
      p(7, "allow_post", "1"),
      p(6, "allow_post", "1"),
    ]);
    expect(r.grants.filter((g) => g.roleKey !== "admin")).toEqual([]);
    expect([...r.stats.unmappedGids]).toEqual([
      [25, 1],
      [7, 1],
    ]);
    expect(r.stats.skippedMutedGroup).toBe(1);
  });

  it("会员取最宽并集：任一 LV 组开启即开启，并记录哪些组未开启", () => {
    const r = translateGlobalGrants([
      p(8, "allow_upload", "0"),
      p(9, "allow_upload", "1"),
      p(10, "allow_upload", "0"),
    ]);
    expect(has(r, "member", "attachment.upload")).toBe(true);
    expect(r.stats.memberPartial).toEqual([
      { permissionKey: "attachment.upload", granted: [9], missing: [8, 10] },
    ]);
  });

  it("管理员始终拥有后台基线；输出有序且去重（确定性）", () => {
    const rows = [p(3, "allow_post", "1"), p(4, "allow_post", "1"), p(5, "allow_post", "1")];
    const a = translateGlobalGrants(rows);
    expect(has(a, "admin", "site.admin")).toBe(true);
    expect(
      a.grants.filter((g) => g.roleKey === "admin" && g.permissionKey === "forum.write"),
    ).toHaveLength(1);
    expect(translateGlobalGrants([...rows].reverse())).toEqual(a);
  });
});

describe("translateUserRoles", () => {
  const users = new Set([1, 2, 3, 4, 5]);

  it("附加组与主组都翻译为角色；会员/游客是隐式角色不落行", () => {
    const r = translateUserRoles(
      [
        { uid: 1, gid: 18, endtime: 0 },
        { uid: 2, gid: 8, endtime: 0 },
        { uid: 3, gid: 2, endtime: 0 },
      ],
      [{ uid: 4, gid: 3 }],
      users,
      ASOF,
    );
    expect(r.rows.map((x) => [x.userId, x.roleKey])).toEqual([
      [1, "team-subtitle"],
      [4, "admin"],
    ]);
    expect(r.stats.implicitSkipped).toBe(2);
    expect(r.rows[0]).toMatchObject({
      scopeId: 0,
      expiresAt: null,
      grantedBy: null,
      grantedAt: ASOF,
    });
  });

  it("gid 23 → 实习组，gid 38 → 策划组（v1 曾映射反）", () => {
    const r = translateUserRoles(
      [
        { uid: 1, gid: 23, endtime: 0 },
        { uid: 2, gid: 38, endtime: 0 },
      ],
      [],
      users,
      ASOF,
    );
    expect(r.rows.map((x) => x.roleKey)).toEqual(["team-intern", "team-planning"]);
  });

  it("同用户同角色：永久优先于带过期；都带过期取更晚者；主组与附加组去重", () => {
    const r = translateUserRoles(
      [
        { uid: 1, gid: 18, endtime: unix("2030-01-01 00:00:00") },
        { uid: 1, gid: 18, endtime: 0 },
        { uid: 2, gid: 21, endtime: unix("2029-01-01 00:00:00") },
        { uid: 2, gid: 21, endtime: unix("2031-01-01 00:00:00") },
      ],
      [{ uid: 1, gid: 18 }],
      users,
      ASOF,
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows.find((x) => x.userId === 1)?.expiresAt).toBeNull();
    expect(r.rows.find((x) => x.userId === 2)?.expiresAt).toBe("2031-01-01 00:00:00");
  });

  it("已过期、用户不存在、未映射 gid、禁止发言组分别计数并跳过", () => {
    const r = translateUserRoles(
      [
        { uid: 1, gid: 18, endtime: unix("2019-01-01 00:00:00") },
        { uid: 99, gid: 18, endtime: 0 },
        { uid: 2, gid: 19, endtime: 0 },
        { uid: 3, gid: 6, endtime: 0 },
      ],
      [],
      users,
      ASOF,
    );
    expect(r.rows).toEqual([]);
    expect(r.stats).toMatchObject({ expiredSkipped: 1, orphanUsers: 1, mutedGroupSkipped: 1 });
    expect(r.stats.unmappedGids.get(19)).toBe(1);
  });

  it("同一权限下不同输入顺序得到相同结果（确定性）", () => {
    const belong = [
      { uid: 2, gid: 18, endtime: 0 },
      { uid: 1, gid: 21, endtime: 0 },
    ];
    const a = translateUserRoles(belong, [], users, ASOF);
    const b = translateUserRoles([...belong].reverse(), [], users, ASOF);
    expect(b.rows).toEqual(a.rows);
  });
});
