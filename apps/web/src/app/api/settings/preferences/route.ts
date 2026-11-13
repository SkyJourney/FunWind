import { NextResponse } from "next/server";
import { z } from "zod";
import { getWebDb, notificationPreferences } from "@funwind/db";
import { preferenceGuard } from "@/lib/net/preference-guard";
import { setUserPmPolicy } from "@/lib/pm/policy";
import { setUserThemePack } from "@/lib/theme/pref";

/**
 * 设置中心开关类偏好 API（M10.6d 站长反馈：通知/私信偏好变更应即时生效 + toast，不整页跳转）。
 * PATCH { kind: "notif", channel, type, enabled } 切通知偏好单格；{ kind: "pmPolicy", pmPolicy } 切私信三态；
 * PATCH { kind: "themePack", pack } 切主题包偏好（M11；null = 跟随站点默认，顶栏/用户菜单即时切换用）。
 * 会话鉴权、同源与结构校验后共用偏好写入额度；返回更新后的值，客户端乐观渲染。
 */

const patchSchema = z.union([
  z.object({
    kind: z.literal("notif"),
    type: z.string().min(1).max(48),
    channel: z.enum(["in_app", "email", "push"]),
    enabled: z.boolean(),
  }),
  z.object({
    kind: z.literal("pmPolicy"),
    pmPolicy: z.enum(["all", "following", "off"]),
  }),
  z.object({
    kind: z.literal("themePack"),
    pack: z.string().max(32).nullable(),
  }),
]);

export async function PATCH(request: Request): Promise<Response> {
  return preferenceGuard(request, patchSchema, async (user, body) => {
    if (body.kind === "notif") {
      await getWebDb()
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

    if (body.kind === "themePack") {
      const pack = body.pack;
      if (!(await setUserThemePack(user.id, pack))) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      return NextResponse.json({ ok: true, pack });
    }

    await setUserPmPolicy(user.id, body.pmPolicy);
    return NextResponse.json({ ok: true, pmPolicy: body.pmPolicy });
  });
}
