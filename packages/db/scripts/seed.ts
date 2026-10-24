/** db:seed —— 演示数据种子（幂等）。逻辑在 src/seed-data.ts（与 E2E 重置脚本共用） */
import { withDb } from "../src/client.js";
import { seedDemoData } from "../src/seed-data.js";
import { assertSeedAllowed } from "../src/seed-guard.js";

// 守卫已打印原因：这里只以非零码退出，不再多打一段堆栈
const allowed = await withDb(async ({ db }) => {
  try {
    await assertSeedAllowed(db, "db:seed");
  } catch {
    return false;
  }
  await seedDemoData(db);
  return true;
});
if (!allowed) process.exit(1);
console.log("✔ seed 完成（幂等演示数据：90000+ 号段）");
