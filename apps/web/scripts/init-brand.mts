#!/usr/bin/env node
/**
 * 默认站标初始化 CLI（M13 Step 4，D2）：导入路径上线检查单执行（users 非空，安装管线不跑品牌段——F4）。
 * 幂等：池已有当前项即跳过（绝不覆盖站长自定义）；池空则把定稿图 public/logo/qy2010.png
 * 入池（qy2010 包标签）并设为当前。用法：pnpm init-brand（对 NEW_DB_NAME 指向的库执行）。
 *
 * 必须由 package script 预加载 server-only-register.mjs（CLAUDE.md 运维脚本纪律）。
 */
import { ensureDefaultLogo } from "../src/lib/brand/init-brand";
import { getLogoPoolRaw } from "../src/lib/brand/logo-pool";

const result = await ensureDefaultLogo();
const pool = await getLogoPoolRaw();
const active = pool.items.find((i) => i.file === pool.active);

switch (result.action) {
  case "initialized":
    console.log(`✔ 默认站标已初始化：${active?.name}（${result.file}）`);
    break;
  case "skipped-active":
    console.log(`＝ 池已有当前项，跳过（${active?.name}）；如需更换请到后台 /admin/logo。`);
    break;
  case "failed":
    console.error(`✘ 初始化失败：${result.reason}`);
    console.error("  请检查 public/logo/qy2010.png 与 STORAGE_DIR 可写性后重试。");
    // 显式退出：mysql2 连接池不释放事件循环（与 recall-blast 同款处理）
    process.exit(1);
}
process.exit(0);
