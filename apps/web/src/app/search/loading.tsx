import { ListSkeleton } from "@/components/page-skeletons";

/** 搜索页加载态（本段无 notFound 语义，可安全启用 loading 边界；注记见 /boards/loading.tsx） */
export default function Loading() {
  return <ListSkeleton rows={8} />;
}
