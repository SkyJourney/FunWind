import { NextResponse } from "next/server";

/**
 * VAPID 公钥下发（M18 Step 3）：客户端 PushManager.subscribe 需要 applicationServerKey。
 * 公钥本就公开（私钥只在 env、不入库），无需鉴权；未配置时返回空串，客户端据此优雅隐藏推送入口。
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({ publicKey: process.env.VAPID_PUBLIC_KEY ?? "" });
}
