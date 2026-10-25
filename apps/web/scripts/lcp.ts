/**
 * perf:lcp —— 生产构建 LCP 断言（门禁：<2500ms，本地基准）。
 * 用法：pnpm build 之后 pnpm --filter @funwind/web exec tsx scripts/lcp.ts
 * 流程：spawn `next start -p 3200` → 逐页测量 LCP → 输出报告 → 杀进程。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 3200;
const BASE = `http://127.0.0.1:${PORT}`;
const PAGES: [string, string][] = [
  ["/", "首页"],
  ["/f/109", "版块页（动画アニメ）"],
  ["/t/6621", "帖子详情（刀剣乱舞）"],
  ["/search?q=刀剣乱舞", "搜索页（M8）"],
];
const BUDGET_MS = 2500;

function startServer(): ChildProcess {
  return spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("next start 未在 30s 内就绪");
}

async function measureLcp(page: import("@playwright/test").Page, url: string): Promise<number> {
  await page.goto(`${BASE}${url}`, { waitUntil: "load" });
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const po = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          if (entries.length > 0) resolve(entries[entries.length - 1]!.startTime);
        });
        po.observe({ type: "largest-contentful-paint", buffered: true } as PerformanceObserverInit);
        setTimeout(() => resolve(-1), 3000);
      }),
  );
}

async function main(): Promise<void> {
  const server = startServer();
  try {
    await waitForServer();
    const browser = await chromium.launch();
    const page = await browser.newPage();
    let fails = 0;
    for (const [url, label] of PAGES) {
      const lcp = await measureLcp(page, url);
      const ok = lcp >= 0 && lcp < BUDGET_MS;
      if (!ok) fails++;
      console.log(
        `${ok ? "✔" : "✘"} ${label.padEnd(14)} LCP ${lcp.toFixed(0)}ms（预算 ${BUDGET_MS}ms）`,
      );
    }
    await browser.close();
    if (fails > 0) {
      console.error(`\n${fails} 页超预算`);
      process.exitCode = 1;
    } else {
      console.log("\nLCP 全部达标");
    }
  } finally {
    server.kill("SIGTERM");
  }
}

void main();
