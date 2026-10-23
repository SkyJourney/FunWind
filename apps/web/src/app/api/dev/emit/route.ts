import { NextResponse } from "next/server";

// API 路由与页面是两棵模块图：各自显式求值模块注册表
import "@/modules";
import { isEventName, validateEventPayload } from "@/modules/kernel/event-names";
import { emit } from "@/modules/kernel/bus";

/**
 * DEV ONLY：模拟领域事件（如 user.logged_in 假会话），供 M2 E2E 与本地调试。
 * 生产构建该路由不可达（双重守卫：文件级 + 构建期排除见 next.config）。
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  let body: { event?: string; payload?: Record<string, unknown>; actorId?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!isEventName(body.event)) {
    return NextResponse.json({ error: `unknown event: ${String(body.event)}` }, { status: 400 });
  }
  const payloadError = validateEventPayload(body.event, body.payload);
  if (payloadError) {
    return NextResponse.json({ error: payloadError }, { status: 400 });
  }
  const payload = body.payload as never;
  const result = await emit(body.event, payload, { source: "dev-api", actorId: body.actorId });
  return NextResponse.json(result);
}
