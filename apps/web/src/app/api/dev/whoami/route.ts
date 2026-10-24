import { NextResponse } from "next/server";
import { newDbConfig } from "@funwind/db";
import { devOnlyResponse } from "@/lib/dev-only";

/** DEV ONLY：回显当前进程实际连接的数据库（E2E 隔离校验用） */
export async function GET() {
  const blocked = devOnlyResponse();
  if (blocked) return blocked;
  return NextResponse.json({ database: newDbConfig().database, nodeEnv: process.env.NODE_ENV });
}
