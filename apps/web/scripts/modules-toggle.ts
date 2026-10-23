#!/usr/bin/env node
/** 模块装卸 CLI（M9 前过渡）：pnpm --filter @funwind/web exec tsx scripts/modules-toggle.ts <id> <on|off> */
import { setModuleEnabled } from "../src/modules/kernel/state.js";
import { getModules } from "../src/modules/kernel/registry.js";

const [id, action] = process.argv.slice(2);

if (!id || !["on", "off"].includes(action ?? "")) {
  console.error("用法: tsx scripts/modules-toggle.ts <module-id> <on|off>");
  console.error(
    "已注册模块:",
    getModules()
      .map((m) => m.id)
      .join(", ") || "（无）",
  );
  process.exit(1);
}
if (!getModules().some((m) => m.id === id)) {
  console.error(
    `未知模块: ${id}。已注册:`,
    getModules()
      .map((m) => m.id)
      .join(", "),
  );
  process.exit(1);
}

await setModuleEnabled(id, action === "on");
console.log(
  `✔ 模块 ${id} → ${action === "on" ? "启用" : "停用"}（module_state 已更新；重跑生效于下次请求）`,
);
