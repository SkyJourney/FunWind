import { respondToFeed } from "@/lib/feeds/http";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return respondToFeed(request, { kind: "latest" });
}

export const HEAD = GET;
