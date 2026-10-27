"use client";

import Link from "next/link";
import { useId } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 段级错误边界（S2 states.html ③定稿）：就地可恢复——错误 ID 便于对日志，重试/回首页双出口。
 * 文案保持社区口吻；ID 用 Next digest（服务端错误必有），纯客户端错误无追踪 ID。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const fallbackId = useId();
  const id = error.digest ?? `client-${fallbackId}`;
  return (
    <main className="mx-auto grid max-w-3xl place-items-center px-4 py-20 text-center">
      <div className="max-w-md space-y-4">
        <AlertTriangle className="mx-auto size-10 text-muted-foreground/60" aria-hidden />
        <h1 className="text-xl font-bold">页面开小差了</h1>
        <p className="text-sm text-muted-foreground">
          错误已记录（ID: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{id}</code>
          ），可重试或回到首页。
        </p>
        <div className="flex justify-center gap-2">
          <Button onClick={reset}>
            <RotateCw className="size-4" aria-hidden /> 重试
          </Button>
          <Button variant="outline" asChild>
            <Link href="/">返回首页</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
