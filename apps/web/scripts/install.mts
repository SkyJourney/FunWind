#!/usr/bin/env node
/**
 * 安装 CLI（M12，docs/milestones/M12-install-wizard.md）：Web 安装向导的命令行等价物。
 * 与向导共用同一份安装管线（lib/install 的六步幂等状态机），非交互、env/参数驱动，
 * 适合无头/自动化部署。用法见 README「零数据部署」章节：
 *   pnpm install:cli --admin-username=... --admin-email=... --admin-password=...
 *   pnpm install:cli --unlock --yes ...   （删除安装锁并重装；--unlock 交互确认，--yes 跳过）
 *
 * 可选覆盖（均有默认值，见 lib/install/schema.ts 的 installConfigFromEnv）：
 *   --site-name= --site-tagline= --site-url= --theme=default
 *   --registration=open|invite|closed [--verify-email]（仅 open 模式有意义）
 * 数据库连接一律读 .env（NEW_DB_*）：运行中的实例不能换库，CLI 不提供连接参数。
 *
 * 必须由 package script 预加载 server-only-register.mjs（CLAUDE.md 运维脚本纪律）。
 */
import { createInterface } from "node:readline/promises";
import { getWebPool } from "@funwind/db";
import { isInstalled, removeInstallLock } from "../src/lib/install/lock";
import { getStorageDir } from "../src/lib/storage";
import { INSTALL_STEPS, runInstallStep } from "../src/lib/install/run-install";
import {
  installConfigFromEnv,
  validateInstallConfig,
  type InstallConfig,
  type InstallThemePack,
} from "../src/lib/install/schema";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const arg of argv) {
    if (arg === "--unlock" || arg === "--yes" || arg === "--verify-email") {
      args[arg.slice(2)] = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) args[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return args;
}

const str = (args: Args, key: string): string | undefined => {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

async function confirmUnlock(): Promise<boolean> {
  // 非交互环境（无 TTY）不进确认，直接拒绝——重装必须有人在场
  if (!process.stdin.isTTY) {
    console.error(
      "✘ --unlock 需要交互确认：请在本机终端运行，或加 --yes 显式跳过确认（自动化场景）。",
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("删除 install.lock 并允许重装？输入 yes 确认：")).trim();
  rl.close();
  return answer === "yes";
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // 锁路径显式化（审查 P2-8）：STORAGE_DIR 错位（systemd 与 shell 不一致）时，操作者一眼看出
  console.log(`[install:cli] 安装锁路径：${getStorageDir()}/install.lock`);

  // 覆盖参数 → 默认配置（db 五项来自 .env），再过一遍与向导完全相同的校验
  const registrationArg = str(args, "registration");
  if (registrationArg !== undefined && !["open", "invite", "closed"].includes(registrationArg)) {
    console.error(`✘ --registration 只接受 open / invite / closed，收到：${registrationArg}`);
    return 1;
  }
  const registration =
    registrationArg === "open"
      ? { mode: "open" as const, verifyEmail: args["verify-email"] === true }
      : registrationArg === "closed"
        ? { mode: "closed" as const }
        : { mode: "invite" as const };
  const raw = installConfigFromEnv({
    site: {
      name: str(args, "site-name") ?? "青翼字幕组",
      tagline: str(args, "site-tagline") ?? "日语·ACG 情怀社区",
      url: str(args, "site-url") ?? "http://127.0.0.1:3100",
    },
    themePack: (str(args, "theme") ?? "default") as InstallThemePack,
    registration,
    admin: {
      username: str(args, "admin-username") ?? "",
      email: str(args, "admin-email") ?? "",
      password: str(args, "admin-password") ?? "",
    },
  });
  const validated = validateInstallConfig(raw);
  if (!validated.ok) {
    console.error("✘ 安装配置无效：");
    for (const [field, message] of Object.entries(validated.issues)) {
      console.error(`  · ${field}：${message}`);
    }
    console.error(
      "  CLI 安装必须提供 --admin-username / --admin-email / --admin-password；站点信息可用默认值或用上面的参数覆盖。",
    );
    return 1;
  }
  const config: InstallConfig = validated.value;

  if (args.unlock === true) {
    if (await isInstalled()) {
      const confirmed = args.yes === true ? true : await confirmUnlock();
      if (!confirmed) {
        console.log("已取消：安装锁未删除。");
        return 1;
      }
      await removeInstallLock();
      console.log("✔ 安装锁已删除（--unlock）。重装完成后会重新写入。");
    } else {
      console.log("ℹ 站点尚未安装（无 install.lock），无需解锁，直接进入安装。");
    }
  } else if (await isInstalled()) {
    console.error(
      "✘ 站点已完成安装（存在 install.lock）。如需重装：pnpm install:cli --unlock --yes ...",
    );
    return 1;
  }

  for (const step of INSTALL_STEPS) {
    console.log(`[install:cli] 开始 step=${step}`);
    const result = await runInstallStep(step, config);
    if (!result.ok) {
      console.error(`✘ step=${step} 失败（${result.code}）：${result.message}`);
      return 1;
    }
    console.log(`✔ step=${step} 完成`);
  }

  console.log(
    `✔ 安装完成：管理员「${config.admin.username}」可直接登录（${config.site.url}/login）。` +
      "生产部署请核对 .env 的 APP_URL / TRUSTED_PROXY_HOPS / SMTP_URL 与 README「零数据部署」检查清单。",
  );
  return 0;
}

const exitCode = await main();
// getWebDb 的连接池会占着事件循环：必须显式退出（CLAUDE.md 已知坑）
await getWebPool()
  .end()
  .catch(() => {});
process.exit(exitCode);
