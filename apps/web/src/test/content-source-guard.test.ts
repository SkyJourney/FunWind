// @vitest-environment node
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSources, type Sources } from "./source-graph";
import { productionSources } from "./content-source-symbols";
import {
  IDENTITY_EXCEPTIONS,
  identitySourceProblems,
  imageSourceProblems,
} from "./content-source-rules";

const PROCESSOR = "lib/uploads/process-image.ts";
const IMAGE_ASSET = "lib/uploads/image-asset.ts";
const IMAGE_SOURCES: Sources = {
  [PROCESSOR]: `export async function processImage(input: unknown) { return input; }
    export class ProcessError extends Error {}
    export interface ProcessOptions { maxBytes: number }`,
  [IMAGE_ASSET]: `import { processImage } from './process-image';
    export const imageAsset = (value: unknown) => processImage(value);`,
};
const DB = `import { accountDeletionRequests as requests } from '@funwind/db';
  import { eq, inArray, sql } from 'drizzle-orm';`;
const sources = loadSources(join(import.meta.dirname, ".."));

// 这里只读源码：不导入业务服务、不创建连接，不承担 G05/G08 或独立品牌素材 sharp 管线检查。
describe("内容源单一出口（G11/G13）", () => {
  it("processImage 定义唯一且生产值入口仅 image-asset，类与类型可直接导入", () => {
    expect(imageSourceProblems(sources)).toEqual([]);
  });
  it("注销身份/资格谓词只来自公共表达式或逐函数说明的必要例外", () => {
    expect(identitySourceProblems(sources)).toEqual([]);
  });
  it("每个例外都锁定真实存在的命名函数、精确状态集合与原因", () => {
    for (const entry of IDENTITY_EXCEPTIONS) {
      expect(entry.reason.trim(), `${entry.path}#${entry.owner}`).not.toBe("");
      expect(entry.states.length).toBeGreaterThan(0);
      const without = IDENTITY_EXCEPTIONS.filter((candidate) => candidate !== entry);
      const problems = identitySourceProblems({ [entry.path]: sources[entry.path] }, without);
      expect(
        problems.some((problem) => problem.includes(`[${entry.owner}]`)),
        `${entry.path}#${entry.owner}`,
      ).toBe(true);
    }
  });
});

describe("G11 合成源码", () => {
  it.each([
    "import { processImage as encode } from '@/lib/uploads/process-image'; encode(input);",
    "import * as image from '@/lib/uploads/process-image'; image.processImage(input);",
    "import * as image from '@/lib/uploads/process-image'; const local = image; local['processImage'](input);",
    "const { processImage: encode } = await import('@/lib/uploads/process-image'); encode(input);",
    "const image = await import('@/lib/uploads/process-image'); image.processImage(input);",
    "(await import('@/lib/uploads/process-image'))['processImage'](input);",
    "import('@/lib/uploads/process-image').then(({ processImage: encode }) => encode(input));",
    "import('@/lib/uploads/process-image').then(image => image.processImage(input));",
    "import * as image from '@/lib/uploads/process-image'; image[computed](input);",
    "import * as image from '@/lib/uploads/process-image'; consume(image);",
  ])("阻止直接、别名、命名空间及字面量动态值绕过：%s", (body) => {
    expect(
      imageSourceProblems({ ...IMAGE_SOURCES, "lib/business.ts": body }).some((problem) =>
        problem.includes("lib/business.ts"),
      ),
    ).toBe(true);
  });
  it.each([
    "export { processImage as encode } from '@/lib/uploads/process-image';",
    "export * from '@/lib/uploads/process-image';",
    "export * as codec from '@/lib/uploads/process-image';",
    "import { processImage as encode } from '@/lib/uploads/process-image'; export { encode };",
  ])("禁止 export-from/barrel 重新暴露底层值：%s", (body) => {
    const input = {
      ...IMAGE_SOURCES,
      "lib/barrel.ts": body,
      "lib/business.ts": "import * as forwarded from './barrel'; consume(forwarded);",
    };
    expect(imageSourceProblems(input).some((problem) => problem.includes("lib/barrel.ts"))).toBe(
      true,
    );
  });
  it("跨多层转发、默认别名、namespace export 仍能定位真实处理函数", () => {
    const input = {
      ...IMAGE_SOURCES,
      "lib/barrel.ts": "export { processImage as default } from '@/lib/uploads/process-image';",
      "lib/next.ts": "export { default as encode } from './barrel';",
      "lib/business.ts": "import { encode } from './next'; encode(input);",
    };
    expect(imageSourceProblems(input).some((problem) => problem.includes("lib/business.ts"))).toBe(
      true,
    );
  });
  it("ProcessError/类型导入与转发、未使用处理函数的 namespace、注释、独立 sharp 都放行", () => {
    expect(
      imageSourceProblems({
        ...IMAGE_SOURCES,
        "app/api/upload/route.ts": `import { ProcessError, type ProcessOptions } from '@/lib/uploads/process-image';
        const error = new ProcessError();`,
        "lib/classes.ts":
          "export { ProcessError } from '@/lib/uploads/process-image'; export type { ProcessOptions } from '@/lib/uploads/process-image';",
        "lib/namespace.ts":
          "import * as image from '@/lib/uploads/process-image'; new image.ProcessError();",
        "lib/dynamic-class.ts":
          "const { ProcessError } = await import('@/lib/uploads/process-image'); new ProcessError();",
        "lib/comments.ts":
          "// processImage(input); export { processImage } from './fake';\nconst text = 'processImage(input)';",
        "lib/chrome/brand-pool-fs.ts": "import sharp from 'sharp'; sharp(input).png();",
      }),
    ).toEqual([]);
  });
  it("定义不能搬走、删除、改为第二个命名函数或箭头实现", () => {
    expect(
      imageSourceProblems({ [IMAGE_ASSET]: IMAGE_SOURCES[IMAGE_ASSET] }).some((problem) =>
        problem.startsWith("processImage 定义"),
      ),
    ).toBe(true);
    for (const body of ["function processImage() {}", "export const processImage = () => value;"]) {
      expect(
        imageSourceProblems({ ...IMAGE_SOURCES, "lib/duplicate.ts": body }).some((problem) =>
          problem.startsWith("processImage 定义"),
        ),
      ).toBe(true);
    }
  });
  it("单测、test/tests 目录可直接使用底层，不污染生产守卫", () => {
    const input = {
      ...IMAGE_SOURCES,
      "lib/uploads/direct.test.ts":
        "import { processImage } from './process-image'; processImage(input);",
      "test/helper.ts": "export * from '@/lib/uploads/process-image';",
      "tests/helper.ts": "export * from '@/lib/uploads/process-image';",
      "lib/tests/direct.ts": "function processImage() {}",
    };
    expect(Object.keys(productionSources(input))).toEqual([PROCESSOR, IMAGE_ASSET]);
    expect(imageSourceProblems(input)).toEqual([]);
  });
});

describe("G13 合成源码", () => {
  it.each([
    `${DB} eq(requests.status, 'completed');`,
    `${DB} const table = requests; inArray(table.status, ['pending', 'completed']);`,
    `import * as db from '@funwind/db'; import * as orm from 'drizzle-orm'; orm.eq(db.accountDeletionRequests.status, 'completed');`,
    `import * as db from '@funwind/db'; import { eq as equal } from 'drizzle-orm'; const { accountDeletionRequests: table } = db; equal(table['status'], 'pending');`,
    `${DB} import { alias as tableAlias } from 'drizzle-orm/mysql-core'; const cloned = tableAlias(requests, 'closing'); inArray(cloned.status, ['pending', 'completed']);`,
    `${DB} const state = requests.status; state !== 'completed';`,
    `${DB} 'pending' === requests.status;`,
    `${DB} const states = ['pending', 'completed'] as const; inArray(requests.status, states);`,
    `${DB} inArray(requests.status, computeStates());`,
  ])("追踪数据库来源、命名别名、namespace、表 alias 与状态比较：%s", (body) => {
    expect(identitySourceProblems({ "lib/business.ts": body })).toHaveLength(1);
  });
  it("数据库转发仍按原导出符号识别", () => {
    expect(
      identitySourceProblems({
        "lib/db.ts": "export { accountDeletionRequests as closures } from '@funwind/db';",
        "lib/business.ts":
          "import { closures as table } from './db'; import { eq } from 'drizzle-orm'; eq(table.status, 'pending');",
      }),
    ).toHaveLength(1);
  });
  it("词法遮蔽、其他来源同名表与注释不是注销表比较", () => {
    expect(
      identitySourceProblems({
        "lib/business.ts": `${DB}
      // eq(requests.status, 'completed');
      const text = "account_deletion_requests adr WHERE adr.status = 'completed'";
      function unrelated(requests: { status: string }) { return requests.status === 'completed'; }
      import { accountDeletionRequests as other } from './unrelated'; eq(other.status, 'completed');
      const unrelatedStatus = { status: 'completed' }; unrelatedStatus.status === 'completed';`,
      }),
    ).toEqual([]);
  });
  it.each([
    "sql`EXISTS (SELECT 1 FROM account_deletion_requests adr WHERE adr.user_id = ${userId} AND adr.status = 'completed')`",
    "sql`NOT EXISTS (SELECT 1 FROM account_deletion_requests AS adr WHERE adr.user_id = ${userId} AND adr.status IN ('pending', 'completed'))`",
    "sql`EXISTS (SELECT 1 FROM ${requests} adr WHERE adr.user_id = ${userId} AND adr.status = ${'pending'})`",
    "sql`${requests.status} = 'completed'`",
    "sql`${requests.status} IN (${states})`",
    "sql.raw(\"EXISTS (SELECT 1 FROM account_deletion_requests adr WHERE adr.status = 'completed')\")",
    "sql`EXISTS (SELECT 1 FROM account_deletion_requests adr WHERE 'completed' = adr.status)`",
  ])("关联 raw SQL 表及 status/EXISTS/NOT EXISTS：%s", (body) => {
    expect(identitySourceProblems({ "lib/business.ts": `${DB} ${body};` })).toHaveLength(1);
  });
  it("raw SQL 支持 SQL 标签别名与 namespace，忽略 SQL 注释及不相关 status", () => {
    expect(
      identitySourceProblems({
        "lib/business.ts": `import * as orm from 'drizzle-orm';
      import { sql as query } from 'drizzle-orm';
      const one = query\`NOT EXISTS (SELECT 1 FROM account_deletion_requests adr WHERE adr.status = 'completed')\`;
      const two = orm.sql\`EXISTS (SELECT 1 FROM account_deletion_requests adr WHERE adr.status IN ('pending', 'completed'))\`;`,
      }),
    ).toHaveLength(2);
    expect(
      identitySourceProblems({
        "lib/business.ts": `${DB}
      sql\`SELECT adr.status FROM account_deletion_requests adr\`;
      sql\`SELECT 'adr.status = completed' FROM account_deletion_requests adr /* adr.status = 'completed' */\`;
      sql\`EXISTS (SELECT 1 FROM other_table adr WHERE adr.status = 'completed')\`;
      sql\`EXISTS (SELECT 1 FROM account_deletion_requests adr JOIN other_table x ON x.id = adr.id WHERE x.status = 'completed')\`;`,
      }),
    ).toEqual([]);
  });
  it("raw SQL 别名限于对应 SELECT，其他子查询复用别名不串表", () => {
    const projection = `${DB} sql\`SELECT EXISTS (SELECT adr.status FROM account_deletion_requests adr)
      OR EXISTS (SELECT 1 FROM unrelated adr WHERE adr.status = 'completed')\`;`;
    expect(identitySourceProblems({ "lib/business.ts": projection })).toEqual([]);
    const filtered = projection.replace(
      "SELECT adr.status FROM account_deletion_requests adr",
      "SELECT 1 FROM account_deletion_requests adr WHERE adr.status = 'completed'",
    );
    expect(identitySourceProblems({ "lib/business.ts": filtered })).toHaveLength(1);
  });
  it("status 字段投影本身不违规，投影后的简单行状态比较才检测", () => {
    const projection = `${DB} const [request] = await db.select({ state: requests.status }).from(requests).limit(1);`;
    expect(identitySourceProblems({ "lib/business.ts": projection })).toEqual([]);
    for (const condition of [
      "request.state === 'completed'",
      "const { state: lifecycle } = request; lifecycle === 'pending'",
    ]) {
      expect(
        identitySourceProblems({ "lib/business.ts": `${projection} ${condition};` }),
      ).toHaveLength(1);
    }
  });
  it("已批准状态机例外仅对真实文件+命名函数+准许状态生效，不依赖行号", () => {
    const body = `${DB}\n\n\n export async function createRequestInTx() {
      return inArray(requests.status, ['pending', 'completed']); }`;
    const path = "lib/auth/account-deletion.ts";
    expect(identitySourceProblems({ [path]: body })).toEqual([]);
    expect(identitySourceProblems({ "lib/elsewhere.ts": body })).toHaveLength(1);
    expect(
      identitySourceProblems({ [path]: body.replace("createRequestInTx", "newEligibility") }),
    ).toHaveLength(1);
    expect(
      identitySourceProblems({ [path]: body.replace("'completed'", "'cancelled'") }),
    ).toHaveLength(1);
    expect(
      identitySourceProblems({
        [path]: body + "function hiddenEligibility() { return eq(requests.status, 'completed'); }",
      }),
    ).toHaveLength(1);
  });
  it("公共箭头表达式精确命名；匿名回调可继承外层，嵌套命名函数不能继承", () => {
    const path = "lib/identity-expr.ts";
    const raw =
      "sql`NOT EXISTS (SELECT 1 FROM account_deletion_requests adr WHERE adr.status = 'completed')`";
    const good = `import { sql } from 'drizzle-orm'; export const userNotDeleted = () => ${raw};`;
    expect(identitySourceProblems({ [path]: good })).toEqual([]);
    expect(
      identitySourceProblems({ [path]: good.replace("userNotDeleted", "businessEligibility") }),
    ).toHaveLength(1);
    expect(
      identitySourceProblems({
        "lib/auth/account-deletion.ts": `${DB}
      function createRequestInTx() { transaction(() => inArray(requests.status, ['pending', 'completed']));
        function bypass() { return eq(requests.status, 'pending'); } }`,
      }),
    ).toHaveLength(1);
  });
  it("申诉 pending-only 与 PM FOR UPDATE 不能借例外扩大状态或移除查询锁", () => {
    const path = "lib/authz/appeals.ts";
    const appeal = `${DB} function submitAppealAsUser() { return eq(requests.status, 'pending'); }`;
    expect(identitySourceProblems({ [path]: appeal })).toEqual([]);
    expect(
      identitySourceProblems({ [path]: appeal.replace("'pending'", "'completed'") }),
    ).toHaveLength(1);
    const pm = `${DB} function sendMessage() { return tx.select({id: requests.id}).from(requests)
      .where(inArray(requests.status, ['pending', 'completed'])).for('update'); }`;
    expect(identitySourceProblems({ "lib/pm/service.ts": pm })).toEqual([]);
    expect(
      identitySourceProblems({ "lib/pm/service.ts": pm.replace(".for('update')", "") }),
    ).toHaveLength(1);
  });
  it("必要治理/安全例外不豁免同文件新增函数，site-admin 不列例外", () => {
    for (const [path, owner] of [
      ["lib/authz/subject.ts", "loadSubject"],
      ["lib/badges/service.ts", "grantBadgeByAdmin"],
      ["lib/auth/session.ts", "readCurrentSessionUser"],
      ["lib/auth/tokens.ts", "consumeEmailTokenInTx"],
      ["lib/identity.ts", "lockActiveUserInTx"],
    ]) {
      const good = `${DB} function ${owner}() { return inArray(requests.status, ['pending', 'completed']); }`;
      expect(identitySourceProblems({ [path]: good })).toEqual([]);
      expect(
        identitySourceProblems({ [path]: good.replace(owner, "newBusinessEligibility") }),
      ).toHaveLength(1);
    }
    expect(
      identitySourceProblems({
        "lib/authz/site-admin-invariant.ts": `${DB} function globalPermissionHolders() { return inArray(requests.status, ['pending', 'completed']); }`,
      }),
    ).toHaveLength(1);
    const admin = `${DB} function listAdminUsersPage() { return eq(requests.status, 'pending'); }`;
    expect(identitySourceProblems({ "lib/authz/admin-user-views.ts": admin })).toEqual([]);
    expect(
      identitySourceProblems({
        "lib/authz/admin-user-views.ts": admin.replace("'pending'", "'cancelled'"),
      }),
    ).toHaveLength(1);
  });
  it("明确静态局限：任意跨函数数据流及非字面量动态 SQL 不做完整推断", () => {
    expect(
      identitySourceProblems({
        "lib/business.ts": `${DB}
      const predicate = makeQuery(requests); predicate.status === 'completed';
      sql.raw(buildSql());`,
      }),
    ).toEqual([]);
  });
});
