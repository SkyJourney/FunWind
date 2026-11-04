import "server-only";

import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { getWebPool } from "@funwind/db";

/**
 * 任务互斥（M11.5）：MySQL 命名锁 GET_LOCK / RELEASE_LOCK。
 *
 * 选它而不是租约表：零表结构变更；锁绑在**连接**上，进程崩溃、网络断开时 MySQL 自动释放，不会死锁。
 * 代价是必须占住一条**专用连接**直到任务结束（连接池只有 8 条，调度器串行执行，所以最多额外占 1 条；
 * 任务自己的事务另借连接，仍遵守「事务内不再借第二条连接」的约定）。
 */

/** 命名锁的持有句柄。release 保证不抛：失败时销毁连接，让服务器侧释放锁 */
export interface LockHandle {
  release(): Promise<void>;
}

/** 抢锁接口：抢到返回句柄，没抢到（别的实例在跑）返回 null，数据库不可用时抛错 */
export interface LockProvider {
  tryAcquire(key: string): Promise<LockHandle | null>;
}

/** MySQL 命名锁名称上限 64 个字符 */
const MAX_LOCK_NAME = 64;

/**
 * 锁名带上库名：GET_LOCK 是**服务器级**的，同一台 MySQL 上的开发库、E2E 库、各个临时测试库
 * 如果用同一个锁名，会互相抢锁。超长时改用哈希，保证确定且不超过上限。
 */
export function lockNameOf(dbName: string, key: string): string {
  const raw = `fw:${dbName}:${key}`;
  if (raw.length <= MAX_LOCK_NAME) return raw;
  return `fw:h:${createHash("sha1").update(raw).digest("hex")}`;
}

/** 基于 MySQL 命名锁的实现，使用 web 单例连接池里借出的一条专用连接 */
export function createMysqlLocks(): LockProvider {
  return {
    async tryAcquire(key) {
      const conn = await getWebPool().getConnection();
      let held = false;
      let name = "";
      try {
        const [dbRows] = await conn.query<RowDataPacket[]>("SELECT DATABASE() AS db");
        name = lockNameOf(String(dbRows[0]?.db ?? ""), key);
        const [rows] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS got", [name]);
        held = Number(rows[0]?.got) === 1;
      } catch (error) {
        // 抢锁过程出错：连接状态不可信，直接销毁而不是还回池里
        conn.destroy();
        throw error;
      }
      if (!held) {
        conn.release();
        return null;
      }
      return {
        async release() {
          try {
            const [rows] = await conn.query<RowDataPacket[]>("SELECT RELEASE_LOCK(?) AS released", [
              name,
            ]);
            if (Number(rows[0]?.released) === 1) {
              conn.release();
              return;
            }
            // 不是 1 说明这把锁不在本连接名下（不应发生）：销毁连接，确保不会把仍带锁的连接还回池里
            conn.destroy();
          } catch {
            conn.destroy();
          }
        },
      };
    },
  };
}
