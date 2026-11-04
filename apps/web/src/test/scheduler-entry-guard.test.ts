// @vitest-environment node
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph, loadSources, resolveModule } from "./source-graph";

/**
 * 调度入口守卫（M11.5）。
 *
 * 现有的 modules-import-guard 只认 route.ts 与 "use server" 文件，不认定时任务入口，
 * 所以这两条结构性约束必须在这里单独钉住：
 *  1. 定时任务是第三种使用模块内核的入口，可能早于任何页面请求触发——任务本体（tasks.ts，调度器与命令行脚本共用）必须**静态**引入 @/modules，
 *     否则任务里发出的事件会因渠道 / 消费者不可见而失败（失败即封闭）；
 *  2. instrumentation.ts 同时被 Edge 运行时编译，只能按 NEXT_RUNTIME 分流并**动态** import 调度器，
 *     不能有任何静态运行时依赖，否则 Node 专用代码（连接池、crypto）会被拖进 Edge 构建。
 */
const SRC = join(import.meta.dirname, "..");
const sources = loadSources(SRC);
const { modules } = buildGraph(sources);

describe("调度入口守卫", () => {
  it("tasks.ts 静态引入 @/modules（任务本体的模块内核初始化保障，调度器与脚本共用）", () => {
    const tasks = modules.get("lib/scheduler/tasks.ts");
    expect(tasks, "lib/scheduler/tasks.ts 应存在").toBeDefined();
    const eager = tasks!.imports.some(
      (edge) =>
        edge.runtime &&
        !edge.dynamic &&
        (edge.specifier === "@/modules" ||
          resolveModule("lib/scheduler/tasks.ts", edge.specifier, sources) === "modules/index.ts"),
    );
    expect(eager).toBe(true);
  });

  it("instrumentation.ts 没有任何静态运行时依赖，调度器只经动态 import 引入", () => {
    const file = modules.get("instrumentation.ts");
    expect(file, "src/instrumentation.ts 应存在").toBeDefined();
    const staticRuntime = file!.imports.filter((edge) => edge.runtime && !edge.dynamic);
    expect(staticRuntime.map((edge) => edge.specifier)).toEqual([]);
    const dynamic = file!.imports.filter((edge) => edge.runtime && edge.dynamic);
    expect(dynamic.map((edge) => edge.specifier)).toEqual(["@/lib/scheduler"]);
  });

  it("instrumentation.ts 按 NEXT_RUNTIME 分流：非 nodejs 运行时直接返回", () => {
    const text = sources["instrumentation.ts"]!;
    expect(text).toMatch(/process\.env\.NEXT_RUNTIME\s*!==\s*["']nodejs["']/);
    // 分流判断必须出现在动态 import 之前
    expect(text.indexOf("NEXT_RUNTIME")).toBeLessThan(text.indexOf("import("));
  });

  it("调度器以外的代码不得直接 new Cron：定时任务只能经 lib/scheduler 登记，才有锁与日志", () => {
    const offenders = [...modules.values()]
      .filter((m) => !m.path.startsWith("lib/scheduler/"))
      .filter((m) => m.imports.some((edge) => edge.runtime && edge.specifier === "croner"))
      .map((m) => m.path);
    expect(offenders).toEqual([]);
  });
});
