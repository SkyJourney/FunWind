import "@/modules";
import { manageReviewInput, reviewManagePost } from "@/lib/manage/content-writes";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";

export const dynamic = "force-dynamic";

export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageReviewInput, "postId");
    return manageOk(await reviewManagePost(ctx, params));
  },
  { endpoint: "posts.review" },
);
