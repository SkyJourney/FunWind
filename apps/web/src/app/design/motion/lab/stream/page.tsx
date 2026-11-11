import { Suspense } from "react";
import Link from "next/link";

/**
 * M15 Step 0-4 实验页：流式加载（Suspense 服务端延迟 400ms）+ 长列表滚动。
 * E2E 验证：导航过渡正常、fallback→内容水合不产生二次 VT、长页滚动后返回再进滚动恢复无互扰。
 */
async function Delayed(): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return (
    <p className="rounded-lg border p-3 text-sm">
      流式内容已就绪（400ms 延迟）——若过渡期间它到达，快照/水合不应产生二次过渡或报错。
    </p>
  );
}

export default function LabStream() {
  const items = Array.from({ length: 40 }, (_, i) => `条目 ${i + 1}`);
  return (
    <main className="mx-auto max-w-2xl space-y-3 px-4 py-10">
      <h1 className="text-xl font-semibold">Lab Stream</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">流式加载中…</p>}>
        <Delayed />
      </Suspense>
      <ol className="space-y-2">
        {items.map((item) => (
          <li key={item} className="rounded-lg border p-3 text-sm">
            {item}
          </li>
        ))}
      </ol>
      <Link className="text-primary underline" href="/design/motion/lab/two">
        去-two（滚到底后点走，返回验证滚动恢复）
      </Link>
    </main>
  );
}
