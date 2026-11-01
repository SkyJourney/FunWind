import { describe, expect, it } from "vitest";
import { backfillLegacyPasswordHashes } from "./backfill-legacy-password.js";

interface LegacyRow {
  uid: number;
  password: string | null;
  salt: string | null;
}
interface TargetUser {
  state: "active" | "deleted";
  passwordHash: string | null;
  legacyHash: string | null;
  pending: boolean;
}

const sourceRows: LegacyRow[] = [
  { uid: 1, password: "a".repeat(32), salt: "salt01" },
  { uid: 2, password: "bad-hash", salt: "salt02" },
  { uid: 3, password: "b".repeat(32), salt: "salt03" },
  { uid: 4, password: "c".repeat(32), salt: "salt04" },
  { uid: 5, password: "d".repeat(32), salt: "salt05" },
];

function fixture() {
  const users = new Map<number, TargetUser>([
    [1, { state: "active", passwordHash: null, legacyHash: null, pending: false }],
    [2, { state: "active", passwordHash: null, legacyHash: null, pending: false }],
    [3, { state: "active", passwordHash: null, legacyHash: "md5$old$old001", pending: true }],
    [4, { state: "active", passwordHash: "$argon2id$claimed", legacyHash: null, pending: false }],
    [5, { state: "deleted", passwordHash: null, legacyHash: null, pending: false }],
  ]);
  const oldCursors: number[] = [];
  const updates: string[] = [];

  const oldQuery = async (query: string, params: unknown[] = []): Promise<unknown[]> => {
    if (!/^\s*select\b/i.test(query)) throw new Error("old database must remain read-only");
    const [after, limit] = params.map(Number);
    oldCursors.push(after!);
    return sourceRows.filter((row) => row.uid > after!).slice(0, limit!);
  };

  const newQuery = async (query: string, params: unknown[] = []): Promise<unknown> => {
    if (query.includes("COUNT(*) AS total")) {
      return [
        {
          total: [...users.values()].filter((u) => u.state === "active" && u.passwordHash === null)
            .length,
        },
      ];
    }
    if (query.includes("COUNT(*) AS done")) {
      return [{ done: [...users.values()].filter((u) => u.pending).length }];
    }
    if (query.startsWith("UPDATE users SET legacy_password_hash")) {
      updates.push(query);
      const [legacyHash, rawId] = params;
      const user = users.get(Number(rawId));
      if (
        user &&
        user.state === "active" &&
        user.passwordHash === null &&
        user.legacyHash === null
      ) {
        user.legacyHash = String(legacyHash);
        user.pending = true;
        return { affectedRows: 1 };
      }
      return { affectedRows: 0 };
    }
    throw new Error(`unexpected new query: ${query}`);
  };

  return { users, oldCursors, updates, oldQuery, newQuery };
}

describe("backfillLegacyPasswordHashes（默认双轨密码回填核心）", () => {
  it("只读旧库；有效旧材料回填 md5$hash$salt，跳过无材料/已认领/已有 legacy/非活动用户", async () => {
    const f = fixture();
    const stats = await backfillLegacyPasswordHashes({
      oldQuery: f.oldQuery,
      newQuery: f.newQuery,
      batchSize: 2,
    });

    expect(stats).toEqual({
      candidates: 3,
      scanned: 5,
      backfilled: 1,
      skippedNoMaterial: 1,
      skippedTarget: 3,
      pending: 2,
    });
    expect(f.users.get(1)).toEqual({
      state: "active",
      passwordHash: null,
      legacyHash: `md5$${"a".repeat(32)}$salt01`,
      pending: true,
    });
    expect(f.users.get(3)?.legacyHash).toBe("md5$old$old001");
    expect(f.users.get(4)?.passwordHash).toBe("$argon2id$claimed");
    expect(f.users.get(4)?.pending).toBe(false);
    expect(f.users.get(5)?.legacyHash).toBeNull();
    expect(f.oldCursors).toEqual([0, 2, 4, 5]); // 游标分页不重不漏，最后一页后再查询一次空批
    expect(
      f.updates.every((sql) =>
        sql.includes("password_hash IS NULL AND legacy_password_hash IS NULL"),
      ),
    ).toBe(true);
  });

  it("重复执行幂等：已回填材料不覆盖、不重复计数为新回填", async () => {
    const f = fixture();
    await backfillLegacyPasswordHashes({
      oldQuery: f.oldQuery,
      newQuery: f.newQuery,
      batchSize: 10,
    });
    const firstHash = f.users.get(1)?.legacyHash;
    const second = await backfillLegacyPasswordHashes({
      oldQuery: f.oldQuery,
      newQuery: f.newQuery,
      batchSize: 10,
    });
    expect(second.backfilled).toBe(0);
    expect(f.users.get(1)?.legacyHash).toBe(firstHash);
    expect(second.pending).toBe(2);
  });

  it("拒绝无效 batchSize", async () => {
    const f = fixture();
    await expect(
      backfillLegacyPasswordHashes({ oldQuery: f.oldQuery, newQuery: f.newQuery, batchSize: 0 }),
    ).rejects.toThrow("batchSize must be a positive integer");
  });
});
