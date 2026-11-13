// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph, findDependencyPath, loadSources, type Sources } from "./source-graph";

const WEB = join(import.meta.dirname, "../..");
const SRC = join(WEB, "src");
const require = createRequire(import.meta.url);

const SERVER_BOUNDARIES = [
  "lib/audit.ts",
  ...[
    "session",
    "tokens",
    "register",
    "login",
    "settings",
    "forgot",
    "email-change",
    "account-deletion",
    "password",
    "token",
  ].map((name) => `lib/auth/${name}.ts`),
  ...[
    "subject",
    "snapshot",
    "service",
    "require-admin",
    "admin",
    "appeals",
    "restrictions-admin",
    "team-membership",
    "restrictions",
  ].map((name) => `lib/authz/${name}.ts`),
  ...[
    "forums",
    "threads",
    "posts",
    "users",
    "search",
    "follows-feed",
    "followed-lists",
    "locate-post",
    "public-identity",
  ].map((name) => `lib/queries/${name}.ts`),
  ...["account", "apply", "adjust", "earn", "ledger", "reward-load", "channels"].map(
    (name) => `lib/points/${name}.ts`,
  ),
  "lib/uploads/file-serving.ts",
  "lib/emoji/serving.ts",
  "lib/chrome/site-chrome.ts",
  "lib/theme/pref.ts",
  "lib/theme/catalog.ts",
  "lib/theme/packs.ts",
  "lib/posting/edit-page.ts",
  "lib/pm/reachability.ts",
  // M14：运维任务管线的 HTTP 客户端（持有 OPS_API_TOKEN）、配置写服务、台账读取
  // M17：告警邮件的防重查询与发送（读 email_log、调邮件渠道）
  ...["client", "tasks", "runs", "alert-mail"].map((name) => `lib/ops/${name}.ts`),
  // M17 Step 4：RUM 样本落库（写 rum_samples）
  "lib/rum/ingest.ts",
  // M17 Step 6：CSP 违规报告落库（写 csp_reports）
  "lib/csp/ingest.ts",
  // M17 Step 6.5：查询层与 SQL 共享件均 server-only；schema.ts 仅服务端（带 zod），
  // 加 marker 把「客户端误引 zod 拖进每页 bundle」变成硬错误（双栖的是零依赖 protocol.ts）
  "lib/rum/schema.ts",
  "lib/rum/queries.ts",
  "lib/csp/queries.ts",
  "lib/sql.ts",
  // M18 Step 2：Web Push 投递（web-push + push_log）与通知渠道（偏好/开关/频控）
  "lib/push/transport.ts",
  "lib/push/notify.ts",
  // M18 Step 3：订阅凭据管理（写 push_subscriptions）+ 设置类写 API 共享门口链
  "lib/push/subscriptions.ts",
  "lib/net/preference-guard.ts",
].sort();

function serverOnlyProblems(sources: Sources, required: readonly string[]) {
  const { modules, graph } = buildGraph(sources);
  const marked = new Set(
    [...modules.values()]
      .filter((source) =>
        source.imports.some((edge) => edge.runtime && edge.specifier === "server-only"),
      )
      .map((source) => source.path),
  );
  const missing = required.filter((path) => !marked.has(path));
  const polluted: string[][] = [];
  for (const source of modules.values()) {
    if (!source.directives.includes("use client")) continue;
    const path = findDependencyPath(
      graph,
      source.path,
      (path) => marked.has(path),
      (path) => modules.get(path)?.directives.includes("use server") ?? false,
    );
    if (path) polluted.push(path);
  }
  return { missing, polluted };
}

describe("服务端污染防线（G-05）", () => {
  const sources = loadSources(SRC);
  it("明确列出的 IO/凭据服务都有真实副作用 marker", () => {
    expect(serverOnlyProblems(sources, SERVER_BOUNDARIES).missing).toEqual([]);
  });
  it("所有 use client 入口的运行时闭包都不能加载服务端模块，Action 作为序列化边界", () => {
    expect(serverOnlyProblems(sources, []).polluted).toEqual([]);
  });
  it("共享编辑器、配额、分页、身份表达式及展示模块不被误标", () => {
    for (const path of [
      "lib/paging.ts",
      "lib/identity-expr.ts",
      "lib/limits/quota.ts",
      "lib/editor/markdown/roundtrip.ts",
      "lib/editor/markdown/extensions.ts",
      "lib/editor/markdown/gate.ts",
      "lib/points/labels.ts",
      "lib/theme/surface-render.ts",
      "lib/ops/executors.ts",
      // M17 Step 4：RUM 载荷契约的零依赖类型/常量是双栖的（客户端构造 payload 也要用），标了会断客户端闭包。
      // schema.ts（zod 校验）仅服务端，已加 server-only 并列入 SERVER_BOUNDARIES，不在此清单。
      "lib/rum/protocol.ts",
      // M18 Step 2：Push 类型零依赖双栖（客户端订阅流程也 import），标了会断客户端闭包
      "lib/push/types.ts",
    ]) {
      const { modules } = buildGraph({ [path]: sources[path] });
      expect(
        modules.get(path)?.imports.some((edge) => edge.specifier === "server-only"),
        path,
      ).toBe(false);
    }
  });
  it("Next 的真实 poison 入口在普通模块环境拒绝加载", () => {
    const entry = require.resolve("next/dist/compiled/server-only/index.js");
    const result = spawnSync(process.execPath, ["-e", "require(process.argv[1])", entry], {
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot be imported from a Client Component module");
  });
  it("CLI 仅重定向 marker，不切换 React；真实凭据服务能被脚本加载且不连接数据库", () => {
    const script = `await import('server-only'); const react = await import('react'); if (typeof react.useState !== 'function') throw new Error('React 条件被切换'); const imported = await import('./src/lib/auth/password.ts'); const password = imported.default ?? imported; if (typeof password.hashPassword !== 'function') throw new Error('凭据服务未正确加载'); console.log('marker-ok');`;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/server-only-register.mjs",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
      ],
      { cwd: WEB, encoding: "utf8" },
    );
    expect(output.trim()).toBe("marker-ok");
  });
});

describe("服务端污染图自身", () => {
  const io = "import 'server-only'; export const secret = 1;";
  it.each([
    "import { secret } from '@/lib/io';",
    "export { secret } from '@/lib/io';",
    "const value = import('@/lib/io');",
  ])("追踪客户端间接依赖：%s", (body) => {
    const sources = {
      "components/view.tsx": "'use client'; import '@/lib/shared';",
      "lib/shared.ts": body,
      "lib/io.ts": io,
    };
    expect(serverOnlyProblems(sources, []).polluted).toEqual([
      ["components/view.tsx", "lib/shared.ts", "lib/io.ts"],
    ]);
  });
  it("type-only 与标记注释不是运行时边，真正 Action 是边界", () => {
    const sources = {
      "components/view.tsx":
        "'use client'; import type { X } from '@/lib/io'; import { action } from '@/app/actions/x';",
      "app/actions/x.ts": "'use server'; import '@/lib/io';",
      "lib/io.ts": io,
      "lib/fake.ts": "// import 'server-only'; export {};",
    };
    expect(serverOnlyProblems(sources, ["lib/io.ts", "lib/fake.ts"])).toEqual({
      missing: ["lib/fake.ts"],
      polluted: [],
    });
  });
  it("纯模块保持共享；缺失的必需服务文件不能因扫描遗漏而通过", () => {
    expect(
      serverOnlyProblems(
        {
          "components/view.tsx": "'use client'; import '@/lib/pure';",
          "lib/pure.ts": "export const x = 1;",
        },
        ["lib/missing.ts"],
      ),
    ).toEqual({ missing: ["lib/missing.ts"], polluted: [] });
  });
});
