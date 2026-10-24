/** db:e2e-fixtures —— E2E 专用夹具（幂等）。须在 db:bootstrap 与 db:seed 之后运行。 */
import { withDb } from "../src/client.js";
import { seedE2eFixtures } from "../src/e2e-fixtures.js";
import { assertSeedAllowed } from "../src/seed-guard.js";

// 守卫已打印原因：这里只以非零码退出，不再多打一段堆栈
const allowed = await withDb(async ({ db }) => {
  try {
    await assertSeedAllowed(db, "db:e2e-fixtures");
  } catch {
    return false;
  }
  await seedE2eFixtures(db);
  return true;
});
if (!allowed) process.exit(1);
console.log("✔ E2E 夹具就绪（950000+ 号段）");
