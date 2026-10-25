/**
 * outbox 补派脚本（M7，docs/MODULES.md §outbox）：循环 drainOutbox 直到清空或达到轮次上限。
 * 用法：pnpm outbox:drain（对 NEW_DB_NAME 指向的库执行；持续失败的行看 event_outbox.dispatch_error）。
 * 模块注册表必须先求值——否则补派时没有消费者，事件会被「派发」进空集合并标记完成（= 丢失）。
 */
import { drainOutbox } from "../src/lib/events/outbox";
import "../src/modules";

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
    console.error(
      "存在持续失败的行（dispatch_error 已记录原因），本轮停止——修复消费方后重跑本脚本。",
    );
    break;
  }
}
console.log(`补派结束：共派发 ${totalDispatched} 条`);
if (totalDispatched === 0) {
  console.error("注意：本轮没有派发任何行——若 db:verify 的 outbox 检查仍在报滞留，");
  console.error(
    "说明存在持续失败的行（见 event_outbox.dispatch_error），需要人工修复消费方或数据。",
  );
  process.exit(1);
}
