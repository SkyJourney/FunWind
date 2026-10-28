import { BoardsSkeleton } from "@/components/page-skeletons";

/**
 * 板块目录加载态。安全注记：loading 边界会让响应提前以 200 开始流式输出，
 * 该段内任何 notFound() 都无法再把状态码改为 404——因此 loading.tsx 只允许出现在
 * 「确定不会 notFound()」的段（本页与 /search）；板块页/主题页等 404 能力路由一律不加。
 * 见 docs/M10.5-UI-LAYOUT.md §6 与 e2e/authz、visibility 的 404 契约。
 */
export default function Loading() {
  return <BoardsSkeleton />;
}
