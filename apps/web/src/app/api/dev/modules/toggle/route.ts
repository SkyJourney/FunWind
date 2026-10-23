import { NextResponse } from "next/server";

// API 路由与页面是两棵模块图：各自显式求值模块注册表
import "@/modules";
import { getEnabledModuleIds, setModuleEnabled } from "@/modules/kernel/state";
import { getModules } from "@/modules/kernel/registry";

/**
 * DEV ONLY：模块装卸（module_state 读写），供 M2 E2E 与本地调试。
 * 生产不可达；M9 由 /admin 模块管理页替代。
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const enabled = await getEnabledModuleIds();
  return NextResponse.json({
    modules: getModules().map((m) => ({
      id: m.id,
      enabled: enabled.has(m.id),
      description: m.description,
    })),
  });
}

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  let body: { id?: string; enabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body.id !== "string" || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "需要 { id: string, enabled: boolean }" }, { status: 400 });
  }
  if (!getModules().some((m) => m.id === body.id)) {
    return NextResponse.json({ error: `unknown module: ${body.id}` }, { status: 404 });
  }
  await setModuleEnabled(body.id, body.enabled);
  return NextResponse.json({ ok: true, id: body.id, enabled: body.enabled });
}
