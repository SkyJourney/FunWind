// @vitest-environment node
/** 审计中心查询与 CSV 生成（M9）：筛选、分页、RFC 4180 转义。 */
import { sql } from "drizzle-orm";
import { auditLog, getWebDb } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { csvRows, queryAuditLogs, queryEventLogs } from "./logs";

let tdb: TempDb;
const db = () => getWebDb();

beforeAll(async () => {
  tdb = await setupTempDb();
  await db()
    .insert(auditLog)
    .values([
      {
        actorId: 90004,
        action: "points.adjust",
        targetType: "user",
        targetId: "90005",
        afterJson: { delta: 7 },
        ip: "127.0.0.1",
        createdAt: "2026-10-26 10:00:00",
      },
      {
        actorId: 90004,
        action: "restriction.create",
        targetType: "user",
        targetId: "90005",
        afterJson: { reason: '含,逗号"引号"\n换行' },
        ip: null,
        createdAt: "2026-10-26 11:00:00",
      },
    ]);
  await db().execute(
    sql`INSERT INTO event_log (event_name, payload, actor_id, source, created_at)
        VALUES ('user.logged_in', '{}', 90005, 'auth', '2026-10-26 12:00:00')`,
  );
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("审计中心查询（M9）", () => {
  it("audit_log 筛选（action/actor）与分页", async () => {
    const all = await queryAuditLogs({});
    expect(all.total).toBeGreaterThanOrEqual(2);
    const byAction = await queryAuditLogs({ action: "points.adjust" });
    expect(byAction.total).toBe(1);
    expect(byAction.items[0].targetId).toBe("90005");
    const byActor = await queryAuditLogs({ actorId: 90004 });
    expect(byActor.total).toBe(2);
    const paged = await queryAuditLogs({ limit: 1, offset: 0 });
    expect(paged.items).toHaveLength(1);
  });

  it("event_log 按 event_name 筛选", async () => {
    const rows = await queryEventLogs({ action: "user.logged_in" });
    expect(rows.total).toBeGreaterThanOrEqual(1);
    expect(rows.items[0].source).toBe("auth");
  });

  it("csvRows：RFC 4180 转义（逗号/引号/换行）", () => {
    const csv = csvRows([
      {
        id: 1,
        createdAt: "2026-10-26 10:00:00",
        action: "points.adjust",
        actorId: 90004,
        targetType: "user",
        targetId: "90005",
        detail: "plain",
      },
      {
        id: 2,
        createdAt: "2026-10-26 11:00:00",
        action: "restriction.create",
        actorId: null,
        targetType: "user",
        targetId: "90005",
        detail: '含,逗号"引号"\n换行',
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("id,created_at,action,actor_id,target_type,target_id,detail");
    expect(lines[1]).toBe("1,2026-10-26 10:00:00,points.adjust,90004,user,90005,plain");
    expect(lines[2]).toBe(
      '2,2026-10-26 11:00:00,restriction.create,,user,90005,"含,逗号""引号""\n换行"',
    );
  });
});
