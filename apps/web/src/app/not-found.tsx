import Link from "next/link";
import { Compass, FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 全站 404（notFound() 落点）：文案刻意二义——「不存在或无权访问」，
 * 受限版块/帖子以 404 隐藏存在性的语义不因本页泄露（S2 admin-global 规格）。
 */
export default function NotFound() {
  return (
    <main className="mx-auto grid max-w-3xl place-items-center px-4 py-20 text-center">
      <div className="max-w-md space-y-4">
        <FileQuestion className="mx-auto size-10 text-muted-foreground/60" aria-hidden />
        <h1 className="text-xl font-bold">页面不存在，或你无权访问</h1>
        <p className="text-sm text-muted-foreground">链接可能已过期——试试搜索，或回首页逛逛。</p>
        <div className="flex justify-center gap-2">
          <Button asChild>
            <Link href="/">
              <Compass className="size-4" aria-hidden /> 回首页
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/search">去搜索</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
