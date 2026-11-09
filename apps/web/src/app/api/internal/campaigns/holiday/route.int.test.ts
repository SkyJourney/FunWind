// @vitest-environment node
/**
 * 节日装扮内部动作接口（M14 Step 4，D8）：token 鉴权、effect/窗口校验、create-if-absent 幂等
 * 与「不覆盖站长微调」语义——真实临时库 + 真实 campaigns 写服务链路。
 */
import { eq } from "drizzle-orm";
import { campaigns, getWebDb } from "@funwind/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { insertQy2010Fixture } from "@/test/qy2010-pack-fixture";

let tdb: TempDb;

const TOKEN = "holiday-route-token";
const URL = "http://localhost/api/internal/campaigns/holiday";
const okBody = {
  name: "春节装扮·2027年",
  effect: "theme.pack",
  target: "qy2010",
  startsAt: "2027-02-06 00:00:00",
  endsAt: "2027-02-13 00:00:00",
};

async function call(token: string | null, body: unknown, method = "POST") {
  const { POST } = await import("./route");
  return POST(
    new Request(URL, {
      method,
      headers: token ? { "x-ops-token": token, "content-type": "application/json" } : {},
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
  );
}

describe.skipIf(skipDb)("节日装扮内部接口（临时库）", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    await insertQy2010Fixture();
    process.env.OPS_API_TOKEN = TOKEN;
  });
  afterAll(async () => {
    delete process.env.OPS_API_TOKEN;
    await tdb?.teardown();
  });
  afterEach(async () => {
    await getWebDb()
      .delete(campaigns)
      .where(sql`1 = 1`);
  });

  it("错误口令 → 401（信息不泄漏）", async () => {
    const res = await call("wrong", okBody);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain("无效");
  });

  it("缺失口令配置 → 401（未配置等于全拒）", async () => {
    const saved = process.env.OPS_API_TOKEN;
    delete process.env.OPS_API_TOKEN;
    try {
      const res = await call(null, okBody);
      expect(res.status).toBe(401);
    } finally {
      process.env.OPS_API_TOKEN = saved;
    }
  });

  it.each([
    // 路由层：字段缺失/形态（400）
    [{ name: "" }, 400, "name 须为"],
    [{ name: "x" }, 400, "effect 须为"],
    [{ ...okBody, effect: "" }, 400, "effect 须为"],
    [{ ...okBody, startsAt: "" }, 400, "startsAt 须为"],
    [{ ...okBody, startsAt: "2027-02-06" }, 400, "北京时间"],
    [{ ...okBody, endsAt: "2027-02-30 00:00:00" }, 400, "北京时间"],
    // campaigns 写服务：effect 注册/视觉类（422）
    [{ ...okBody, effect: "fx.ghost" }, 422, "未注册的效果类型"],
    [{ ...okBody, effect: "points.boost" }, 422, "视觉类"],
    // campaigns 写服务：target 语法（bad-target，422）
    [{ ...okBody, target: "Bad Pack!" }, 422, "目标语法无效"],
  ])("校验拒绝 %j", async (body, status, fragment) => {
    const res = await call(TOKEN, body);
    const payload = await res.json();
    expect(res.status).toBe(status);
    expect(String(payload.error)).toContain(fragment);
  });

  it("行为类效果拒绝（节日装扮只支持视觉类）", async () => {
    const { registerOpenEffect } = await import("@/lib/campaigns/effects");
    const res = await call(TOKEN, {
      ...okBody,
      effect: "register.open",
      target: registerOpenEffect.key,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("视觉类");
  });

  it("目标不存在（引用失效）→ 422 带说明", async () => {
    const res = await call(TOKEN, { ...okBody, target: "ghost-pack" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("未导入或已停用");
  });

  it("创建成功：走 campaigns 写服务（audit via=pipeline、revision=1）；同键重发 → existing 不变", async () => {
    const first = await call(TOKEN, okBody);
    expect(first.status).toBe(200);
    const body1 = await first.json();
    expect(body1).toMatchObject({ ok: true, existing: false });

    const [row] = await getWebDb().select().from(campaigns).where(eq(campaigns.id, body1.id));
    expect(row).toMatchObject({ name: okBody.name, effect: "theme.pack", revision: 1 });

    const auditsResult = await getWebDb().execute(
      sql`SELECT after_json FROM audit_log WHERE action = 'campaign.create' ORDER BY id DESC LIMIT 1`,
    );
    const auditRows = (
      Array.isArray(auditsResult) && Array.isArray(auditsResult[0]) ? auditsResult[0] : auditsResult
    ) as Array<{ after_json: { via: string } | string }>;
    const afterJson = auditRows[0]?.after_json;
    const after = typeof afterJson === "string" ? JSON.parse(afterJson) : afterJson;
    expect(after?.via).toBe("pipeline");

    // 同键重发：不新建、不改动（revision 不变）
    const second = await call(TOKEN, okBody);
    const body2 = await second.json();
    expect(body2).toMatchObject({ ok: true, existing: true, id: body1.id });
    const [after2] = await getWebDb().select().from(campaigns).where(eq(campaigns.id, body1.id));
    expect(after2.revision).toBe(1);
    const countResult = await getWebDb().execute(
      sql`SELECT COUNT(*) AS n FROM campaigns WHERE name = ${okBody.name}`,
    );
    const countRows = (
      Array.isArray(countResult) && Array.isArray(countResult[0]) ? countResult[0] : countResult
    ) as Array<{ n: number }>;
    expect(Number(countRows[0]?.n)).toBe(1);
  });
});
