/**
 * outbox 补派脚本（M7，docs/MODULES.md §outbox）：循环 drainOutbox 直到清空或达到轮次上限。
 * 用法：pnpm outbox:drain（对 NEW_DB_NAME 指向的库执行；持续失败的行看 event_outbox.dispatch_error）。
 * 模块注册表必须先求值——否则补派时没有消费者，事件会被「派发」进空集合并标记完成（= 丢失）。
 */
async function run(): Promise<number> {
  // 把模块初始化也纳入脚本的错误边界，仍须在首轮派发前完成注册。
  const { drainOutbox } = await import("../src/lib/events/outbox");
  await import("../src/modules");

  const MAX_ROUNDS = 50;
  let totalDispatched = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const s = await drainOutbox();
    totalDispatched += s.dispatched;
    console.log(
      `第 ${round} 轮：补派 ${s.dispatched}，失败 ${s.failed}，剩余 pending ${s.pendingLeft}`,
    );
    if (s.pendingLeft === 0) break;
    if (s.dispatched === 0 && s.failed > 0) {
      console.error("存在持续失败的行，本轮停止——请按 dispatch_error 的类别与标识排查后重跑。");
      break;
    }
  }
  console.log(`补派结束：共派发 ${totalDispatched} 条`);
  if (totalDispatched === 0) {
    console.error("注意：本轮没有派发任何行。若 db:verify 仍报滞留，请查看 dispatch_error。");
  }
  return totalDispatched === 0 ? 1 : 0;
}

// 显式退出，避免连接池让一次性脚本继续驻留。
run().then(
  (code) => process.exit(code),
  () => {
    console.error("[outbox] 补派脚本失败: drain_run_failed（请检查模块或数据库状态）");
    process.exit(1);
  },
);
