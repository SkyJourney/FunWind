import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getWebDb } from "@funwind/db";
import { storageWritable } from "@/lib/install/progress";

export const dynamic = "force-dynamic";

/** DB 探针超时：拨测不能被挂死的连接拖着（mysql2 默认 connect 超时 10s，这里 3s 内必须给结论） */
const DB_PROBE_TIMEOUT_MS = 3000;

/**
 * 健康端点（M13 Step 1 / D3）：供外部拨测与容器 HEALTHCHECK。
 * 探两项：DB 连通（SELECT 1，3 秒超时）与 STORAGE_DIR 可写（复用安装自检的探针）。
 * 响应只含两个布尔位，不泄露错误细节；任一项不健康即 503（拨测据此告警）。
 * 无鉴权：仅暴露两个布尔位，无敏感信息。
 */
export async function GET() {
  const db = await probeDb();
  const storage = await storageWritable();
  const ok = db && storage;
  return NextResponse.json(
    { status: ok ? "ok" : "error", db, storage },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}

async function probeDb(): Promise<boolean> {
  try {
    await withTimeout(getWebDb().execute(sql`SELECT 1`), DB_PROBE_TIMEOUT_MS);
    return true;
  } catch {
    // 连接失败 / 查询失败 / 超时一律不健康；错误细节留在服务端日志，不出响应体
    return false;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("health: db 探针超时")), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
