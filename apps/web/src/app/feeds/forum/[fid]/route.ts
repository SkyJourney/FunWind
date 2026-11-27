import { forumFeedScope, respondToFeed } from "@/lib/feeds/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ fid: string }> },
): Promise<Response> {
  return respondToFeed(request, forumFeedScope((await params).fid));
}

export const HEAD = GET;
