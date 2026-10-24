/**
 * 连接层集成测试（真实 MySQL）：守住「库内 DATETIME = 北京墙面时间」在服务器侧的口径。
 *
 * 背景（审查 P1-1，2026-10-24）：mysql2 的 timezone 选项只管客户端 Date 的序列化，
 * 不改变服务器会话时区；MySQL 容器默认 UTC，NOW() 因此比北京时间晚 8 小时，
 * 封禁/角色过期/会话过期/台账时间整体偏移。旧测试两侧都用 NOW()，自洽而抓不到。
 * 本文件把 NOW() 与「客户端算出的北京墙面时间」直接对比。
 */
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, describe, expect, it } from "vitest";
import { createPool, SESSION_TIME_ZONE_SQL } from "./client.js";
import { newDbConfig } from "./env.js";

const skip = process.env.SKIP_DB_TESTS === "1";

/** 客户端侧的北京墙面时间（独立于被测代码，避免循环论证） */
function beijingWallTime(atMs = Date.now()): string {
  return new Date(atMs + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}

/** "YYYY-MM-DD HH:mm:ss" 当作同一时区解析成毫秒，仅用于求两个墙面时间的差 */
const wallMs = (s: string): number => Date.parse(s.replace(" ", "T") + "Z");

describe.skipIf(skip)("连接层：会话时区", () => {
  // information_schema 一定存在，不依赖具体业务库
  const pool = createPool({ ...newDbConfig(), database: "information_schema" });
  afterAll(() => pool.end());

  it("会话时区被锁定为 +08:00", async () => {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT @@session.time_zone AS tz");
    expect(rows[0]?.tz).toBe("+08:00");
  });

  it("服务器 NOW() 与北京墙面时间同口径（误差 < 5 秒，而不是相差 8 小时）", async () => {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT NOW() AS now");
    const diff = Math.abs(wallMs(String(rows[0]?.now)) - wallMs(beijingWallTime()));
    expect(diff).toBeLessThan(5000);
  });

  it("池里每一条连接都生效，不只是第一条", async () => {
    // 同时借出 6 条连接并让它们都在途，迫使池新建多条连接
    const conns = await Promise.all(Array.from({ length: 6 }, () => pool.getConnection()));
    try {
      const tzs = await Promise.all(
        conns.map(async (c) => {
          const [rows] = await c.query<RowDataPacket[]>("SELECT @@session.time_zone AS tz");
          return rows[0]?.tz;
        }),
      );
      expect(new Set(tzs)).toEqual(new Set(["+08:00"]));
    } finally {
      for (const c of conns) c.release();
    }
  });

  it("SESSION_TIME_ZONE_SQL 是固定的 +08:00 语句（被 db:verify 与 E2E 裸连接复用口径）", () => {
    expect(SESSION_TIME_ZONE_SQL).toBe("SET time_zone = '+08:00'");
  });
});
