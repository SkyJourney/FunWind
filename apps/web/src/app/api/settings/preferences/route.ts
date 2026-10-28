import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getWebDb, notificationPreferences, userProfiles } from "@funwind/db";
import { getCurrentUser } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/net/same-origin";

/**
 * 设置中心开关类偏好 API（M10.6d 站长反馈：通知/私信偏好变更应即时生效 + toast，不整页跳转）。
 * PATCH { channel?, type, enabled } 切通知偏好单格；PATCH { pmPolicy } 切私信三态。
 * 会话鉴权 + 同源校验；返回更新后的值，客户端乐观渲染。
 */

const patchSchema = z.union([
  z.object({
    kind: z.literal("notif"),
    type: z.string().min(1).max(48),
    channel: z.enum(["in_app", "email"]),
    enabled: z.boolean(),
  }),
  z.object({
    kind: z.literal("pmPolicy"),
    pmPolicy: z.enum(["all", "following", "off"]),
  }),
]);

export async function PATCH(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const db = getWebDb();
  if (body.kind === "notif") {
    await db
      .insert(notificationPreferences)
      .values({
        userId: user.id,
        type: body.type,
        channel: body.channel,
        enabled: body.enabled,
      })
      .onDuplicateKeyUpdate({ set: { enabled: body.enabled } });
    return NextResponse.json({
      ok: true,
      channel: body.channel,
      type: body.type,
      enabled: body.enabled,
    });
  }

  await db
    .update(userProfiles)
    .set({ pmPolicy: body.pmPolicy })
    .where(and(eq(userProfiles.userId, user.id), sql`1=1`));
  return NextResponse.json({ ok: true, pmPolicy: body.pmPolicy });
}
