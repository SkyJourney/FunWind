import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { markRead } from "@/lib/notifications/queries";
import { isSameOrigin } from "@/lib/net/same-origin";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).max(100).optional(),
  category: z.enum(["interaction", "message", "moderation", "account", "announcement"]).optional(),
  all: z.boolean().optional(),
});

/** 铃铛「全部已读」/ 点击单条已读（M8）；形态与语义见 docs/NOTIFICATIONS.md §6 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const { ids, category, all } = parsed.data;
  if (!ids && !category && !all) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  await markRead(user.id, { ids, category, all });
  return new NextResponse(null, { status: 204 });
}
