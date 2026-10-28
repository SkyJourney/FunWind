import { Layers } from "lucide-react";

/** 列表页骨架（S2 states.html ①）：标题条 + 行列表，形状与真实列表页同构 */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="加载中"
      className="mx-auto max-w-5xl space-y-4 px-4 py-8 sm:px-6"
    >
      <div className="sk h-7 w-40 rounded-md" />
      <div className="sk h-4 w-64 rounded-md" />
      <div className="rounded-xl border bg-card">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3 border-b px-4 py-3.5 last:border-b-0">
            <div className="sk h-4 flex-1 rounded" />
            <div className="sk h-4 w-16 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 板块目录骨架（/boards，M10.7 站长反馈）：与真实页面**同构**——同样的容器宽度与间距、固定的「板块目录」标题
 * （静态文案不该等数据）、「N 个板块 · N 个主题」一行的占位条、至少一个一级分区（分区标题条 + 两列板块卡片）。
 * 此前用的是首页内容流骨架（筛选胶囊 + 左文右图卡片，容器还更宽），数据一到标题 / 数字 / 分区全是凭空冒出来的，布局也会跳。
 */
export function BoardsSkeleton({
  sections = 1,
  forums = 4,
}: {
  sections?: number;
  forums?: number;
}) {
  return (
    <main aria-busy="true" className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <span role="status" className="sr-only">
        加载中
      </span>
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Layers className="size-6 text-primary" aria-hidden />
          板块目录
        </h1>
        <p className="mt-1 flex h-5 items-center" aria-hidden>
          <span className="sk h-3.5 w-44 rounded" />
        </p>
      </header>
      <section className="space-y-6" aria-hidden>
        {Array.from({ length: sections }, (_, s) => (
          <div key={s}>
            <div className="mb-2 border-b pb-1">
              <div className="sk my-1 h-4 w-28 rounded" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: forums }, (_, i) => (
                <div key={i} className="rounded-xl border bg-card p-4">
                  <div className="sk h-4 w-2/5 rounded" />
                  <div className="sk mt-2.5 h-3 w-3/4 rounded" />
                  <div className="sk mt-3 h-3 w-16 rounded" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}

/** 内容流骨架（首页/版块等 feed 形态）：筛选条 + 左文右图卡片 ×n */
export function FeedSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div
      role="status"
      aria-label="加载中"
      className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6"
    >
      <div className="flex gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="sk h-8 w-16 rounded-full" />
        ))}
      </div>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid gap-2.5">
          {Array.from({ length: cards }, (_, i) => (
            <div key={i} className="flex gap-4 rounded-xl border bg-card p-4">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="sk h-3 w-24 rounded" />
                <div className="sk h-4 w-11/12 rounded" />
                <div className="sk h-3 w-2/3 rounded" />
                <div className="sk h-3 w-1/3 rounded" />
              </div>
              <div className="sk hidden aspect-[16/10] w-28 rounded-lg sm:block" />
            </div>
          ))}
        </div>
        <div className="hidden space-y-4 xl:grid">
          <div className="sk h-40 rounded-xl" />
          <div className="sk h-28 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

/** 阅读页骨架（主题页形态）：标题 + 楼层卡 ×2 + 快速回复位 */
export function ReadingSkeleton() {
  return (
    <div
      role="status"
      aria-label="加载中"
      className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6"
    >
      <div className="sk h-4 w-56 rounded" />
      <div className="sk h-7 w-11/12 rounded-md" />
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex items-center gap-2.5">
            <div className="sk size-8 rounded-full" />
            <div className="sk h-3.5 w-28 rounded" />
          </div>
          <div className="sk h-3.5 w-full rounded" />
          <div className="sk h-3.5 w-10/12 rounded" />
          <div className="sk h-3.5 w-1/2 rounded" />
        </div>
      ))}
    </div>
  );
}
