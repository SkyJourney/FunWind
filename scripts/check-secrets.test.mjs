import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countSuspiciousEmails,
  findEnvSecrets,
  findKeyPatterns,
  scanFile,
  sensitiveValuesFromEnv,
} from "./check-secrets.mjs";

const ENV = `
# 注释行里的 OLD_DB_PASSWORD=should-be-ignored-1234
NEW_DB_HOST=127.0.0.1
NEW_DB_PASSWORD="s3cr3t-Passw0rd-xyz"
OLD_DB_PASSWORD=another-long-secret-9
SHORT_PASSWORD=abc
PLACEHOLDER_PASSWORD=changeme
API_TOKEN=tok_1234567890abcdef
NOT_SENSITIVE=just-a-long-ordinary-value
`;

test("sensitiveValuesFromEnv：只留敏感键 + ≥8 位 + 非占位的值；注释行与普通键忽略", () => {
  const got = sensitiveValuesFromEnv(ENV);
  assert.deepEqual(got.map((s) => s.key).sort(), [
    "API_TOKEN",
    "NEW_DB_PASSWORD",
    "OLD_DB_PASSWORD",
  ]);
  assert.ok(got.every((s) => s.value.length >= 8));
  assert.equal(got.find((s) => s.key === "NEW_DB_PASSWORD").value, "s3cr3t-Passw0rd-xyz"); // 引号已去掉
});

test("findEnvSecrets：命中返回键名，绝不返回值", () => {
  const secrets = sensitiveValuesFromEnv(ENV);
  const hits = findEnvSecrets("root / s3cr3t-Passw0rd-xyz （本地开发）", secrets);
  assert.deepEqual(hits, ["NEW_DB_PASSWORD"]);
  assert.ok(!JSON.stringify(hits).includes("s3cr3t"));
  assert.deepEqual(findEnvSecrets("干净的文本", secrets), []);
});

test("findKeyPatterns：私钥头 / AWS / GitHub / Slack 令牌", () => {
  const pem = "-----BEGIN " + "RSA PRIVATE KEY-----\nabc";
  assert.deepEqual(findKeyPatterns(pem), ["私钥头"]);
  assert.deepEqual(findKeyPatterns("key=AK" + "IAABCDEFGHIJKLMNOP"), ["AWS Access Key"]);
  assert.deepEqual(findKeyPatterns("t=gh" + "p_" + "a".repeat(36)), ["GitHub 令牌"]);
  assert.deepEqual(findKeyPatterns("普通文本 BEGIN PRIVATE 没有完整头"), []);
});

test("countSuspiciousEmails：占位域名 / 作者本人 / 已打码的不算；真实域名算", () => {
  assert.equal(countSuspiciousEmails("alice@demo.local bob@example.com a@x.io"), 0);
  assert.equal(countSuspiciousEmails("sky.jiang.s.z@gmail.com 与 noreply@anthropic.com"), 0);
  assert.equal(countSuspiciousEmails("已打码 j***@126.com 与 7***@qq.com"), 0);
  assert.equal(countSuspiciousEmails("someone@126.com 和 other@qq.com"), 2);
  assert.equal(countSuspiciousEmails("Someone@GMAIL.com"), 1); // 域名大小写不敏感，且不是作者本人
});

test("scanFile：允许清单路径跳过邮箱扫描，但仍查口令与密钥特征", () => {
  const secrets = sensitiveValuesFromEnv(ENV);
  assert.deepEqual(scanFile("docs/a.md", "联系 someone@126.com", secrets), ["1 个疑似真实邮箱"]);
  assert.deepEqual(scanFile("migration/src/lib/pii.test.ts", "jane@126.com", secrets), []);
  assert.deepEqual(
    scanFile("migration/src/lib/pii.test.ts", "x another-long-secret-9 y", secrets),
    ["含 .env 的 OLD_DB_PASSWORD 的值"],
  );
  assert.deepEqual(scanFile("docs/clean.md", "没有任何敏感内容", secrets), []);
});
