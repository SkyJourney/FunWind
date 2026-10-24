/** db:e2e-fixtures —— E2E 专用夹具（幂等）。须在 db:bootstrap 与 db:seed 之后运行。 */
import { withDb } from "../src/client.js";
import { seedE2eFixtures } from "../src/e2e-fixtures.js";

await withDb(async ({ db }) => {
  await seedE2eFixtures(db);
});
console.log("✔ E2E 夹具就绪（950000+ 号段）");
