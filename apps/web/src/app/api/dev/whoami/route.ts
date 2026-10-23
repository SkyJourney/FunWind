import { NextResponse } from "next/server";
import { newDbConfig } from "@funwind/db";

/** DEV ONLY：回显当前进程实际连接的数据库（E2E 隔离校验用） */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ database: newDbConfig().database, nodeEnv: process.env.NODE_ENV });
}
