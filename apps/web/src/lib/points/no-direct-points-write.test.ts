// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：积分变动只能经 applyPoints / applyPointsInTx（硬约定 3c）。
 * 除 lib/points/ 外，任何运行时源文件对 point_ledger / point_accounts 做写操作（insert/update/delete，含手写 SQL）
 * 都会让这个测试变红。读取（显示余额、对账查询）不受限；测试文件里造夹具不受限。
 */
const SRC = join(__dirname, "../..");
const POINTS_DIR = `lib${sep}points${sep}`;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const WRITE_PATTERNS = [
  /\b(insert|update|delete)\(\s*(pointLedger|pointAccounts)\b/,
  /\b(insert\s+into|update|delete\s+from)\s+`?point_(ledger|accounts)\b/i,
];

describe("积分表只能经积分核心写入", () => {
  it("lib/points/ 之外没有任何运行时代码写 point_ledger / point_accounts", () => {
    const offenders = walk(SRC)
      .map((p) => relative(SRC, p))
      .filter((rel) => !rel.startsWith(POINTS_DIR))
      .filter((rel) => !/\.test\.tsx?$/.test(rel))
      .filter((rel) => {
        const text = readFileSync(join(SRC, rel), "utf8");
        return WRITE_PATTERNS.some((re) => re.test(text));
      });
    expect(offenders).toEqual([]);
  });

  it("守卫自身有效：模式确实能识别写操作，且 lib/points/apply.ts 确实在写（防止路径/正则写错导致空转）", () => {
    expect(WRITE_PATTERNS.some((re) => re.test("await tx.insert(pointLedger).values({})"))).toBe(
      true,
    );
    expect(WRITE_PATTERNS.some((re) => re.test("db.update(pointAccounts).set({})"))).toBe(true);
    expect(WRITE_PATTERNS.some((re) => re.test("UPDATE point_accounts SET balance = 0"))).toBe(
      true,
    );
    expect(WRITE_PATTERNS.some((re) => re.test("db.select().from(pointAccounts)"))).toBe(false);
    const apply = readFileSync(join(SRC, "lib/points/apply.ts"), "utf8");
    expect(WRITE_PATTERNS.some((re) => re.test(apply))).toBe(true);
  });
});
