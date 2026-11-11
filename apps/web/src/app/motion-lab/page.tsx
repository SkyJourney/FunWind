import Link from "next/link";

/**
 * M15 Step 0 技术验证入口页（实验代码，Step 4 清账时随 lab 一起移除）：
 * 五项验证的实验都从这里的链接出发，E2E 断言见 e2e-dev/vt-lab.spec.ts（dev 环境可达，
 * prod 下 notFound），结论回写 M15 文档 §10。
 */
/** 实验页生产可达但无入口链接；noindex 防搜索引擎收录，Step 4 清账时整体移除 */
export const metadata = { robots: { index: false } };

export default function LabPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-10">
      <h1 className="text-xl font-semibold">M15 Step 0 · VT 实验室</h1>
      <ul className="list-disc space-y-2 pl-5 text-sm">
        <li>
          <Link className="text-primary underline" href="/motion-lab/one">
            共享段兄弟切换（one）
          </Link>
          ：根 template 不重挂，只应触发段级一次过渡（验证 1）；本页 useLayoutEffect
          延迟声明方向（验证 2a）。
        </li>
        <li>
          <Link className="text-primary underline" href="/motion-lab/two">
            共享段兄弟切换（two）
          </Link>
          ：useEffect 版延迟声明（验证 2b，对照 2a 的时点差异）。
        </li>
        <li>
          <Link className="text-primary underline" href="/motion-lab/stream">
            流式加载 + 滚动恢复
          </Link>
          （验证 4）：Suspense 延迟 400ms 子组件 + 长列表。
        </li>
        <li>
          <Link className="text-primary underline" href="/motion-lab/back">
            返回键实验页
          </Link>
          （验证 3）：E2E 从这里 page.goBack() 观察过渡是否产生。
        </li>
      </ul>
    </main>
  );
}
