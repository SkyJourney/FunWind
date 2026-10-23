/** db:seed —— 演示数据种子（幂等）。逻辑在 src/seed-data.ts（与 E2E 重置脚本共用） */
import { withDb } from "../src/client.js";
import { seedDemoData } from "../src/seed-data.js";

await withDb(async ({ db }) => {
  await seedDemoData(db);
});
console.log("✔ seed 完成（幂等演示数据：90000+ 号段）");
