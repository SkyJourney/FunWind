#!/usr/bin/env node
/**
 * 秘密扫描：防止口令、密钥、真实用户邮箱被写进被跟踪的文件（pre-push 与 CI 都会跑）。
 * 三类检查，全部只看 `git ls-files` 列出的被跟踪文件：
 *   1. 本机 .env 里的敏感值（键名含 PASSWORD / SECRET / TOKEN / KEY，值 ≥ 8 位且不是 changeme 之类占位）是否出现在任何被跟踪文件里；
 *      CI 上没有 .env，这一类自然为空——它的价值在开发者本机的 pre-push。
 *   2. 常见密钥特征（私钥头、云厂商/GitHub 令牌格式）。
 *   3. 疑似真实邮箱：非占位域名、且不在允许清单里的邮箱地址。已打码的（含 *）不会命中。
 * 输出永远只有「文件路径 + 命中类别/键名」，绝不打印口令或邮箱本身，免得扫描日志自己变成泄露源。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SENSITIVE_KEY = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)/i;
const PLACEHOLDER =
  /^(changeme|change-me|password|secret|example|test|e2e|dummy|xxx+|\*+|<.*>|\$\{.*\})$/i;
const MIN_SECRET_LEN = 8;

/** 允许出现的邮箱：占位域名 + 项目自己的发信地址域名 + 作者本人 */
const EMAIL_ALLOW_DOMAINS = new Set([
  "demo.local",
  "test.local",
  "example.com",
  "example.org",
  "example.net",
  "localhost",
  "x.io",
  "b.io",
  "qingyisub.top",
  "users.noreply.github.com",
  "anthropic.com",
]);
const EMAIL_ALLOW_ADDRESSES = new Set(["sky.jiang.s.z@gmail.com"]);
/** 这些文件里刻意用合成的“看起来像真实域名”的邮箱做脱敏函数的测试输入 */
const EMAIL_ALLOW_PATHS = new Set([
  "migration/src/lib/pii.test.ts",
  "apps/web/src/lib/auth/email.test.ts", // 邮箱格式校验的合成输入（含刻意畸形的地址）
  "scripts/check-secrets.test.mjs",
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// 用拼接构造，避免本文件自己匹配自己
const KEY_PATTERNS = [
  {
    name: "私钥头",
    re: new RegExp("-----BEGIN " + "(?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY" + "-----"),
  },
  { name: "AWS Access Key", re: new RegExp("\\bAK" + "IA[0-9A-Z]{16}\\b") },
  { name: "GitHub 令牌", re: new RegExp("\\bgh" + "[pousr]_[A-Za-z0-9]{36,}\\b") },
  { name: "Slack 令牌", re: new RegExp("\\bxox" + "[baprs]-[A-Za-z0-9-]{10,}") },
];

/** 解析 .env，只留“敏感键 + 足够长 + 非占位”的值 */
export function sensitiveValuesFromEnv(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const [, key, raw] = m;
    const value = raw.trim().replace(/^["']|["']$/g, "");
    if (SENSITIVE_KEY.test(key) && value.length >= MIN_SECRET_LEN && !PLACEHOLDER.test(value)) {
      out.push({ key, value });
    }
  }
  return out;
}

/** 文本里命中了哪些 .env 敏感键（只返回键名） */
export function findEnvSecrets(text, secrets) {
  return secrets.filter((s) => text.includes(s.value)).map((s) => s.key);
}

export function findKeyPatterns(text) {
  return KEY_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

/** 疑似真实邮箱的数量（不返回内容） */
export function countSuspiciousEmails(text) {
  let n = 0;
  for (const m of text.matchAll(EMAIL_RE)) {
    const addr = m[0];
    const domain = addr.slice(addr.lastIndexOf("@") + 1).toLowerCase();
    if (EMAIL_ALLOW_ADDRESSES.has(addr.toLowerCase()) || EMAIL_ALLOW_DOMAINS.has(domain)) continue;
    n++;
  }
  return n;
}

export function scanFile(relPath, text, secrets) {
  const findings = [];
  for (const key of findEnvSecrets(text, secrets)) findings.push(`含 .env 的 ${key} 的值`);
  for (const name of findKeyPatterns(text)) findings.push(`疑似${name}`);
  if (!EMAIL_ALLOW_PATHS.has(relPath)) {
    const n = countSuspiciousEmails(text);
    if (n > 0) findings.push(`${n} 个疑似真实邮箱`);
  }
  return findings;
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString("utf8").split("\0").filter(Boolean);
}

function main() {
  const envPath = path.join(ROOT, ".env");
  const secrets = existsSync(envPath) ? sensitiveValuesFromEnv(readFileSync(envPath, "utf8")) : [];
  let scanned = 0;
  const bad = [];
  for (const rel of trackedFiles()) {
    if (rel === "pnpm-lock.yaml") continue;
    const abs = path.join(ROOT, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // 已删除但尚未提交
    }
    if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue; // 二进制
    scanned++;
    const findings = scanFile(rel, buf.toString("utf8"), secrets);
    if (findings.length) bad.push({ rel, findings });
  }
  console.log(
    `秘密扫描：${scanned} 个被跟踪文件，.env 敏感值 ${secrets.length} 项参与比对${secrets.length === 0 ? "（无 .env，仅做特征与邮箱扫描）" : ""}`,
  );
  if (bad.length === 0) {
    console.log("✔ 未发现口令、密钥特征或疑似真实邮箱");
    return;
  }
  console.error("✘ 发现疑似敏感内容（只显示位置，不显示内容）：");
  for (const b of bad) console.error(`  ${b.rel}: ${b.findings.join("；")}`);
  console.error(
    "处理：把口令移到不入库的 .env；真实邮箱换成合成地址；确属合成测试数据则加入脚本里的允许清单。",
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
