import { getCurrentSubject } from "@/lib/authz/subject";
import { locatePost, postPath } from "@/lib/queries/locate-post";

/**
 * /p/{pid}：按点击者视角跳到帖子所在的页与锚点（M6.1 第 6 步）。
 * 页码由服务端按观众可见的回帖计算，所以隐藏 / 待审的中间楼层不影响跳转结果。
 * 观众看不到的帖子一律 404，不暴露它是否存在（硬约定 7）。
 * Location 用相对地址：不依赖反向代理下的 Host，与 /t/{tid} 的地址形态一致。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ pid: string }> }) {
  const { pid } = await params;
  const id = /^\d{1,10}$/.test(pid) ? Number(pid) : 0;
  const notFound = () => new Response("not found", { status: 404 });
  if (id <= 0) return notFound();
  const loc = await locatePost(await getCurrentSubject(), id);
  if (!loc) return notFound();
  return new Response(null, { status: 302, headers: { location: postPath(loc) } });
}
