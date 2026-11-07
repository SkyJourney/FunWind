// @vitest-environment node
/**
 * 运营排期写服务（M11.2 Step 4）：真实临时 MySQL。
 * 覆盖：新建 / 编辑 / 乐观锁冲突 / 启停 / 删除 / 引用失效 / 审计 / 缓存失效 / 与读取链联动。
 */
import { and, eq } from "drizzle-orm";
import { auditLog, campaigns, getWebDb, siteSettings } from "@funwind/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { getSiteChrome, invalidateSiteChrome } from "@/lib/chrome/site-chrome";
import type { ConfigActor } from "@/lib/audit";
import { createCampaign, deleteCampaign, setCampaignEnabled, updateCampaign } from "./admin";
import type { CampaignFields } from "./input";
import { listCampaigns } from "./list";

let tdb: TempDb;
const db = () => getWebDb();
const ACTOR: ConfigActor = { userId: 90004, via: "admin", ip: "127.0.0.1" };

beforeAll(async () => {
  tdb = await setupTempDb();
});
afterAll(async () => {
  await tdb?.teardown();
});
afterEach(async () => {
  await db().delete(campaigns);
  await db().delete(auditLog).where(eq(auditLog.targetType, "campaign"));
  await db().delete(siteSettings).where(eq(siteSettings.key, "site.logo"));
  invalidateSiteChrome();
});

const LOGO = "logo-aaaa1111.png";

/** 当前时间前后各一天的窗口（北京墙面时间，用 SQL 取以免依赖进程时区） */
async function aroundNow(): Promise<{ start: string; end: string }> {
  const [rows] = (await db().execute(
    sql`SELECT DATE_FORMAT(NOW() - INTERVAL 1 DAY, '%Y-%m-%d %H:%i:%s') AS s,
               DATE_FORMAT(NOW() + INTERVAL 1 DAY, '%Y-%m-%d %H:%i:%s') AS e`,
  )) as unknown as [{ s: string; e: string }[]];
  return { start: rows[0]!.s, end: rows[0]!.e };
}

async function fields(over: Partial<CampaignFields> = {}): Promise<CampaignFields> {
  const { start, end } = await aroundNow();
  return {
    name: "节日装扮",
    effect: "theme.pack",
    target: "qy2010",
    startsAt: start,
    endsAt: end,
    priority: 0,
    ...over,
  };
}

async function auditOf(action: string) {
  return db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetType, "campaign")));
}

describe.skipIf(skipDb)("新建", () => {
  it("写入方案 + 同事务审计，并立即影响站点读取链", async () => {
    const result = await createCampaign(await fields(), ACTOR);
    expect(result.ok).toBe(true);
    const [row] = await db().select().from(campaigns);
    expect(row).toMatchObject({
      effect: "theme.pack",
      enabled: true,
      revision: 1,
      createdBy: 90004,
    });
    expect(row?.config).toEqual({ pack: "qy2010" });
    const [audit] = await auditOf("campaign.create");
    expect(audit?.actorId).toBe(90004);
    expect((await getSiteChrome()).themePack).toBe("qy2010");
  });

  it("校验失败不落库也不写审计", async () => {
    for (const [over, code] of [
      [{ name: "  " }, "bad-name"],
      [{ effect: "site.decor" }, "bad-effect"],
      [{ target: "BAD ID" }, "bad-target"],
      [{ priority: -1 }, "bad-priority"],
    ] as const) {
      expect(await createCampaign(await fields(over), ACTOR)).toEqual({ ok: false, code });
    }
    expect(await db().select().from(campaigns)).toHaveLength(0);
    expect(await auditOf("campaign.create")).toHaveLength(0);
  });

  it("引用的主题包不存在 / LOGO 不在池内 → missing-ref，不落库", async () => {
    const noPack = await createCampaign(await fields({ target: "no-such-pack" }), ACTOR);
    expect(noPack).toEqual({ ok: false, code: "missing-ref" });
    const noLogo = await createCampaign(await fields({ effect: "site.logo", target: LOGO }), ACTOR);
    expect(noLogo).toEqual({ ok: false, code: "missing-ref" });
    expect(await db().select().from(campaigns)).toHaveLength(0);
  });

  it("LOGO 在池内则通过", async () => {
    await db()
      .insert(siteSettings)
      .values({
        key: "site.logo",
        value: { items: [{ file: LOGO, name: "节日" }], active: null },
        updatedAt: sql`NOW()`,
      });
    const result = await createCampaign(await fields({ effect: "site.logo", target: LOGO }), ACTOR);
    expect(result.ok).toBe(true);
  });
});

async function seed() {
  const created = await createCampaign(await fields(), ACTOR);
  if (!created.ok) throw new Error("夹具创建失败");
  return created.value.id;
}

describe.skipIf(skipDb)("编辑与乐观锁", () => {
  it("revision 匹配 → 保存成功、revision+1、审计记录前后值", async () => {
    const id = await seed();
    const result = await updateCampaign(id, 1, await fields({ name: "改名", priority: 7 }), ACTOR);
    expect(result.ok).toBe(true);
    const [row] = await db().select().from(campaigns).where(eq(campaigns.id, id));
    expect(row).toMatchObject({ name: "改名", priority: 7, revision: 2 });
    const [audit] = await auditOf("campaign.update");
    expect(audit?.beforeJson).toMatchObject({ name: "节日装扮", revision: 1 });
    expect(audit?.afterJson).toMatchObject({ name: "改名", revision: 2 });
  });

  it("旧 revision 提交 → conflict，库内内容与版本都不变", async () => {
    const id = await seed();
    await updateCampaign(id, 1, await fields({ name: "他人改动" }), ACTOR);
    const stale = await updateCampaign(id, 1, await fields({ name: "我的旧草稿" }), ACTOR);
    expect(stale).toEqual({ ok: false, code: "conflict" });
    const [row] = await db().select().from(campaigns).where(eq(campaigns.id, id));
    expect(row).toMatchObject({ name: "他人改动", revision: 2 });
    expect(await auditOf("campaign.update")).toHaveLength(1);
  });

  it("旁路写（启停）同样 revision+1，使打开着的编辑页再提交时冲突", async () => {
    const id = await seed();
    await setCampaignEnabled(id, false, ACTOR);
    expect(await updateCampaign(id, 1, await fields(), ACTOR)).toEqual({
      ok: false,
      code: "conflict",
    });
  });

  it("不存在的方案 → not-found", async () => {
    expect(await updateCampaign(999999, 1, await fields(), ACTOR)).toEqual({
      ok: false,
      code: "not-found",
    });
  });
});

describe.skipIf(skipDb)("启停与删除", () => {
  it("停用后读取链回退，启用后恢复；重复设置同一状态不产生审计与版本变化", async () => {
    const id = await seed();
    expect((await getSiteChrome()).themePack).toBe("qy2010");
    await setCampaignEnabled(id, false, ACTOR);
    expect((await getSiteChrome()).themePack).toBe("default");
    await setCampaignEnabled(id, false, ACTOR);
    await setCampaignEnabled(id, true, ACTOR);
    expect((await getSiteChrome()).themePack).toBe("qy2010");
    expect(await auditOf("campaign.toggle")).toHaveLength(2);
    const [row] = await db().select().from(campaigns).where(eq(campaigns.id, id));
    expect(row?.revision).toBe(3);
  });

  it("删除后即时回退，审计保留删除前快照；再删 → not-found", async () => {
    const id = await seed();
    expect(await deleteCampaign(id, ACTOR)).toMatchObject({ ok: true });
    expect((await getSiteChrome()).themePack).toBe("default");
    const [audit] = await auditOf("campaign.delete");
    expect(audit?.beforeJson).toMatchObject({ name: "节日装扮", effect: "theme.pack" });
    expect(await deleteCampaign(id, ACTOR)).toEqual({ ok: false, code: "not-found" });
  });
});

describe.skipIf(skipDb)("后台列表", () => {
  it("状态与重叠压制来自数据库时钟：高优先级压制低优先级", async () => {
    const low = await seed();
    const high = await createCampaign(await fields({ priority: 9 }), ACTOR);
    const { items } = await listCampaigns();
    expect(items.find((i) => i.id === low)).toMatchObject({
      status: "active",
      overriddenBy: high.ok ? high.value.id : -1,
    });
    expect(items.find((i) => i.id === (high.ok ? high.value.id : 0))?.overriddenBy).toBeNull();
  });

  it("库里写坏的配置在列表里标为无效，且读取链忽略它", async () => {
    await db()
      .insert(campaigns)
      .values({
        name: "坏数据",
        effect: "theme.pack",
        config: { nope: true },
        startsAt: sql`NOW() - INTERVAL 1 DAY`,
        endsAt: null,
        enabled: true,
        priority: 99,
        revision: 1,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      });
    const { items } = await listCampaigns();
    expect(items[0]).toMatchObject({ invalid: true, target: null });
    expect((await getSiteChrome()).themePack).toBe("default");
  });
});

describe.skipIf(skipDb)("行为类时间窗重叠拒绝（M11.4 Q5 / D4）", () => {
  /** 五个时刻：昨天 / 现在 / 明天 / 后天 / 大后天（北京墙面时间，用 SQL 取以免依赖进程时区） */
  async function stamps(): Promise<{ s: string; m: string; e: string; f: string; g: string }> {
    const [rows] = (await db().execute(
      sql`SELECT DATE_FORMAT(NOW() - INTERVAL 1 DAY, '%Y-%m-%d %H:%i:%s') AS s,
                 DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS m,
                 DATE_FORMAT(NOW() + INTERVAL 1 DAY, '%Y-%m-%d %H:%i:%s') AS e,
                 DATE_FORMAT(NOW() + INTERVAL 2 DAY, '%Y-%m-%d %H:%i:%s') AS f,
                 DATE_FORMAT(NOW() + INTERVAL 3 DAY, '%Y-%m-%d %H:%i:%s') AS g`,
    )) as unknown as [{ s: string; m: string; e: string; f: string; g: string }[]];
    return rows[0]!;
  }

  const window = async (over: Partial<CampaignFields> & { span?: [string, string] } = {}) => {
    const fallback = await aroundNow();
    const [startsAt, endsAt] = over.span ?? [fallback.start, fallback.end];
    const { span: _span, ...rest } = over;
    return {
      name: "开放注册窗口",
      effect: "register.open",
      target: "on",
      startsAt,
      endsAt,
      priority: 0,
      ...rest,
    };
  };

  it("创建与已启用的同类方案时间重叠 → overlap，不落库不审计", async () => {
    const first = await createCampaign(await window(), ACTOR);
    expect(first.ok).toBe(true);
    const second = await createCampaign(await window({ name: "窗口B" }), ACTOR);
    expect(second).toEqual({ ok: false, code: "overlap" });
    expect(await db().select().from(campaigns)).toHaveLength(1);
    expect(await auditOf("campaign.create")).toHaveLength(1);
  });

  it("首尾相接不算重叠；不同 effect 互不影响；视觉类重叠语义不变", async () => {
    const { s, m, e } = await stamps();
    const first = await createCampaign(await window({ span: [s, m] }), ACTOR);
    const touching = await createCampaign(await window({ name: "相接", span: [m, e] }), ACTOR);
    expect(first.ok).toBe(true);
    expect(touching.ok).toBe(true);
    const visualA = await createCampaign(await fields({ name: "视觉A" }), ACTOR);
    const visualB = await createCampaign(await fields({ name: "视觉B", priority: 3 }), ACTOR);
    expect(visualA.ok).toBe(true);
    expect(visualB.ok).toBe(true);
  });

  it("停用的方案不参与比较（D4）；重新启用与启用中的同类重叠 → overlap", async () => {
    const first = await createCampaign(await window({ name: "甲" }), ACTOR);
    if (!first.ok) throw new Error("夹具失败");
    // 停用甲后创建窗口相同的乙：甲已停用不参与比较 → 创建成功且为启用
    await setCampaignEnabled(first.value.id, false, ACTOR);
    const second = await createCampaign(await window({ name: "乙" }), ACTOR);
    if (!second.ok) throw new Error("夹具失败");
    // 重新启用甲：与启用中的乙重叠 → 拒（这就是 D4 的重新启用检查）
    expect(await setCampaignEnabled(first.value.id, true, ACTOR)).toEqual({
      ok: false,
      code: "overlap",
    });
    // 停用乙后再启用甲 → 成功；此时再启用乙 → 与甲重叠 → 拒
    await setCampaignEnabled(second.value.id, false, ACTOR);
    expect((await setCampaignEnabled(first.value.id, true, ACTOR)).ok).toBe(true);
    expect(await setCampaignEnabled(second.value.id, true, ACTOR)).toEqual({
      ok: false,
      code: "overlap",
    });
    // 只有真正改变状态的动作写审计：甲停用、乙停用、甲启用
    expect(await auditOf("campaign.toggle")).toHaveLength(3);
    expect(await auditOf("campaign.create")).toHaveLength(2);
  });

  it("编辑自身（保持原窗口）不算重叠；把窗口改成与生效中的他人重叠 → overlap", async () => {
    const { s, e, f, g } = await stamps();
    // A 生效中（昨天 → 明天）；B 在 A 之后未来的独立窗口（后天 → 大天后）
    const a = await createCampaign(await window({ name: "A", span: [s, e] }), ACTOR);
    const b = await createCampaign(await window({ name: "B", span: [f, g] }), ACTOR);
    if (!a.ok || !b.ok) throw new Error("夹具失败");
    const rename = await updateCampaign(
      b.value.id,
      1,
      await window({ name: "B改名", span: [f, g] }),
      ACTOR,
    );
    expect(rename.ok).toBe(true);
    const moved = await updateCampaign(
      b.value.id,
      2,
      await window({ name: "B挪窗", span: [s, e] }),
      ACTOR,
    );
    expect(moved).toEqual({ ok: false, code: "overlap" });
    const [row] = await db().select().from(campaigns).where(eq(campaigns.id, b.value.id));
    expect(row).toMatchObject({ name: "B改名" });
  });

  it("已结束的方案不参与比较：与过去窗口重叠的新窗口放行（半开语义）", async () => {
    await db()
      .insert(campaigns)
      .values({
        name: "已结束",
        effect: "register.open",
        config: {},
        startsAt: sql`NOW() - INTERVAL 2 DAY`,
        endsAt: sql`NOW() - INTERVAL 1 DAY`,
        enabled: true,
        revision: 1,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      });
    const current = await createCampaign(await window({ name: "当前" }), ACTOR);
    expect(current.ok).toBe(true);
    expect(await db().select().from(campaigns)).toHaveLength(2);
  });

  it("两路并发创建重叠方案 → 恰好一个成功（间隙锁 / 死锁重试收敛，F7）", async () => {
    const [a, b] = await Promise.all([
      createCampaign(await window({ name: "并发A" }), ACTOR),
      createCampaign(await window({ name: "并发B" }), ACTOR),
    ]);
    const okOnes = [a, b].filter((r) => r.ok);
    const codes = [a, b].filter((r) => !r.ok).map((r) => (r as { code: string }).code);
    expect(okOnes).toHaveLength(1);
    expect(codes).toEqual(["overlap"]);
    expect(await db().select().from(campaigns)).toHaveLength(1);
    expect(await auditOf("campaign.create")).toHaveLength(1);
  });

  it("两路并发启用停用中的重叠方案 → 恰好一个成功", async () => {
    const a = await createCampaign(await window({ name: "停A" }), ACTOR);
    if (!a.ok) throw new Error("夹具失败");
    await setCampaignEnabled(a.value.id, false, ACTOR);
    const b = await createCampaign(await window({ name: "停B" }), ACTOR);
    if (!b.ok) throw new Error("夹具失败");
    await setCampaignEnabled(b.value.id, false, ACTOR);
    const results = await Promise.all([
      setCampaignEnabled(a.value.id, true, ACTOR),
      setCampaignEnabled(b.value.id, true, ACTOR),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      results.filter((r) => !r.ok).every((r) => (r as { code: string }).code === "overlap"),
    ).toBe(true);
  });
});
