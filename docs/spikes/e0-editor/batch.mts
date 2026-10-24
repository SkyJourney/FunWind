import { writeFileSync } from "node:fs";
const { chromium } =
  await import("/Volumes/Projects/FunWind/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs").catch(
    async () =>
      await import("/Volumes/Projects/FunWind/apps/web/node_modules/playwright-core/index.mjs"),
  );
const which = process.argv[2] ?? "all";
const browser = await chromium.launch();
const page = await browser.newPage();
const errs: string[] = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message.slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") errs.push("console.error: " + m.text().slice(0, 200));
});
await page.goto("http://127.0.0.1:5199/");
await page.waitForFunction(() => (window as any).__spike);
const ids = which === "all" ? ["cm", "milkdown", "tiptap"] : [which];
const result: Record<string, any[]> = {};
for (const id of ids) {
  const t0 = Date.now();
  result[id] = await page.evaluate((id) => (window as any).__spike.runBatch(id), id);
  const rows = result[id]!;
  const by = (f: (r: any) => boolean) => rows.filter(f).length;
  console.log(`\n== ${id}: ${rows.length} 条，耗时 ${Date.now() - t0}ms`);
  console.log(
    `   渲染等价 ${by((r) => r.equiv)} / 逐字相同 ${by((r) => r.same)} / 不等价 ${by((r) => !r.equiv)} / 报错 ${by((r) => r.error)}`,
  );
  const kinds = [...new Set(rows.map((r) => r.kind))];
  for (const k of kinds) {
    const g = rows.filter((r) => r.kind === k);
    console.log(
      `   ${k.padEnd(12)} 等价 ${g.filter((r) => r.equiv).length}/${g.length}  逐字 ${g.filter((r) => r.same).length}/${g.length}`,
    );
  }
  const reasons = new Map<string, number>();
  for (const r of rows.filter((r) => !r.equiv)) {
    const k = (r.error ? "ERR " + r.error : (r.reason ?? "?")).replace(/\d+/g, "N").slice(0, 70);
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  console.log(
    "   不等价原因：",
    JSON.stringify([...reasons].sort((a, b) => b[1] - a[1]).slice(0, 6)),
  );
}
writeFileSync("batch-result.json", JSON.stringify(result));
if (errs.length) console.log("\n页面错误(前5)：", errs.slice(0, 5));
await browser.close();
