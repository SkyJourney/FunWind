import { spawn } from "node:child_process";
import path from "node:path";

/**
 * 真起子进程跑 apps/web/scripts 下的定时脚本（测试专用）。
 *
 * 为什么必须真起进程：参数解析、退出码、「干完活进程会不会自行退出」都是进程级行为，调用服务函数覆盖不到。
 * 「会自行退出」尤其重要：getWebDb 的连接池会一直占着事件循环，脚本若只设 exitCode，
 * 定时任务每调用一次就会留下一个不退出的进程。
 */

const WEB_DIR = path.resolve(import.meta.dirname, "../..");
/** 超过这个期限仍不退出，就杀掉进程并标记 hung */
export const EXIT_DEADLINE_MS = 60_000;

export type ScriptRun = { code: number | null; stdout: string; stderr: string; hung: boolean };

/** 在指定库上跑脚本（预加载服务端 marker 兼容层，与 package.json 里的入口一致） */
export function runWebScript(
  dbName: string,
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<ScriptRun> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "./scripts/server-only-register.mjs",
        "--import",
        "tsx",
        `scripts/${script}`,
        ...args,
      ],
      { cwd: WEB_DIR, env: { ...process.env, ...env, NEW_DB_NAME: dbName } },
    );
    let stdout = "";
    let stderr = "";
    let hung = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      hung = true;
      child.kill("SIGKILL");
    }, EXIT_DEADLINE_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, hung });
    });
  });
}
