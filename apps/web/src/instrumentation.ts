/**
 * Next 启动钩子（M11.5）。register() 在服务实例启动时只调用一次，且必须在服务就绪前返回，
 * 所以这里只登记定时器，不等待任何任务运行。所有运行时都会调用它，Edge 运行时不能加载 Node 专用代码，
 * 因此必须按 NEXT_RUNTIME 分流并动态 import。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startScheduler } = await import("@/lib/scheduler");
  startScheduler();
}
