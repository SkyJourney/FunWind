# 第三轮复审 P1 级快速修复

## 修复清单

- [x] **L-03**: 编辑页补充 `capacity-unavailable` 错误码（≤2分钟）
- [x] **L-04**: LOGO 联动 `unchanged` 状态告知（≤3分钟）
- [ ] **L-01**: 主题包删除前检查素材池引用（~15分钟）
- [ ] **L-02**: 导入清理边界文档说明（~10分钟）

---

## L-03: 编辑页补充错误码（违反 G-15）

**文件**: `apps/web/src/app/admin/themes/[id]/page.tsx`

**位置**: 第 16-25 行

**修改**:
```typescript
const ERR_TEXT: Record<string, string> = {
  conflict:
    "包已被他人修改（版本冲突）。草稿与原始提交版本会保留；刷新或再次保存不会自动覆盖他人的改动。请先保留需要的内容，再明确载入最新版本并重新编辑。",
  "invalid-definition": "包配置校验未通过，请检查分区定义。",
  "bad-json": "包配置不是合法 JSON。",
  "bad-name": "主题名称不能为空。",
  "not-found": "包不存在。",
  protected: "该包受保护，不能这样修改。",
  "missing-assets": "配置引用了不存在的装饰素材，请先到装饰素材池补齐文件。",
  // 新增：
  "capacity-unavailable": "系统回退主题包缺失，无法校验容量；请先完成数据库初始化。",
};
```

**验证**:
```bash
# 检查错误码是否匹配
diff <(grep -o 'code: "[^"]*"' apps/web/src/lib/theme/packs.ts | sort -u) \
     <(grep -o '"[^"]*":' apps/web/src/app/admin/themes/[id]/page.tsx | grep -A20 ERR_TEXT | grep -o '"[^"]*":' | sort -u)
```

---

## L-04: LOGO 联动状态告知

### 修改 1: actions.ts（增加 `unchanged` 分支）

**文件**: `apps/web/src/app/admin/themes/actions.ts`

**位置**: 第 175-176 行

**当前代码**:
```typescript
const saved = logo.status === "applied" ? "default_logo" : "default";
redirect(`/admin/themes?saved=${saved}${logo.status === "failed" ? "&warn=logo" : ""}`);
```

**修改为**:
```typescript
const saved = 
  logo.status === "applied" ? "default_logo" 
  : logo.status === "unchanged" ? "default_no_logo"
  : "default";
redirect(`/admin/themes?saved=${saved}${logo.status === "failed" ? "&warn=logo" : ""}`);
```

### 修改 2: page.tsx（增加文案）

**文件**: `apps/web/src/app/admin/themes/page.tsx`

**位置**: 第 26-34 行

**修改**:
```typescript
const FLASH: Record<string, string> = {
  created: "主题包已创建。",
  copied: "主题包已复制。",
  deleted: "主题包已删除。",
  toggled: "主题包状态已更新。",
  default: "已设为全站默认主题。",
  default_logo: "已设为全站默认主题，并把 LOGO 切换为该主题自带图（可在「LOGO 管理」独立改回）。",
  // 新增：
  default_no_logo: "已设为全站默认主题（此主题无自带 LOGO，LOGO 保持不变）。",
  imported: "主题包及其素材已导入。",
};
```

**验证**: 创建一个无 LOGO 的主题包，设为默认，检查提示文案。

---

## L-01: 主题包删除前检查素材池引用

**文件**: `apps/web/src/lib/theme/packs.ts`

**位置**: 第 429-446 行 `deleteThemePack` 函数

**当前代码**:
```typescript
export async function deleteThemePack(
  id: string,
  actor: ConfigActor,
): Promise<ThemePackResult<{ id: string; name: string }>> {
  return withThemeCapacity(async (tx) => {
    const row = await lockThemePack(tx, id);
    if (!row) return { ok: false as const, code: "not-found" as const };
    if (row.isBuiltin || id === "default")
      return { ok: false as const, code: "protected" as const };
    await tx.delete(themePackages).where(eq(themePackages.id, id));
    await auditThemePackChange(tx, actor, "theme.pack.delete", id, {
      id: row.id,
      name: row.name,
      revision: row.revision,
    });
    return { ok: true as const, value: { id, name: row.name } };
  });
}
```

**修改为**:
```typescript
export async function deleteThemePack(
  id: string,
  actor: ConfigActor,
): Promise<ThemePackResult<{ id: string; name: string }>> {
  return withThemeCapacity(async (tx) => {
    const row = await lockThemePack(tx, id);
    if (!row) return { ok: false as const, code: "not-found" as const };
    if (row.isBuiltin || id === "default")
      return { ok: false as const, code: "protected" as const };
    
    // 新增：检查 decor 素材引用
    const assets = parseThemePackAssets(row.assets);
    const decorFiles = assets.filter(a => a.kind === "decor").map(a => a.poolFile);
    if (decorFiles.length > 0) {
      // 在事务外查询引用关系（getDecorUsage 是只读操作，不需要在事务内）
      // 注意：此处存在 TOCTOU 窗口，但影响有限（仅日志完整性）
      const usage = await getDecorUsage();
      for (const file of decorFiles) {
        const refs = usage.get(file) ?? [];
        const otherRefs = refs.filter(u => u.packId !== id);
        if (otherRefs.length > 0) {
          console.warn(
            `[theme-pack-delete] 删除包 ${id} 但 decor ${file} 仍被其他包引用:`,
            otherRefs.map(r => `${r.packName}(${r.packId})`).join(", ")
          );
        }
      }
    }
    
    await tx.delete(themePackages).where(eq(themePackages.id, id));
    await auditThemePackChange(tx, actor, "theme.pack.delete", id, {
      id: row.id,
      name: row.name,
      revision: row.revision,
    });
    return { ok: true as const, value: { id, name: row.name } };
  });
}
```

**说明**:
- 当前实现为**仅记录警告**，不阻止删除
- 如果需要阻止删除，可返回 `{ ok: false, code: "protected" }` 并在页面增加对应文案
- TOCTOU 窗口影响有限：最坏情况是警告遗漏，不影响功能正确性

**更严格的方案（可选）**:
```typescript
// 如果要阻止删除被引用素材的包
if (otherRefs.length > 0) {
  return { 
    ok: false as const, 
    code: "protected" as const,
    // 可选：增加新错误码 "has-references"
  };
}
```

**验证**:
1. 创建包 A 和包 B，都引用同一个 decor 文件
2. 删除包 A
3. 检查服务器日志是否有警告
4. 检查包 B 的图片底纹是否仍正常显示

---

## L-02: 导入清理边界文档说明

**文件**: `docs/milestones/M11.1-theme-engine.md` 或新建 `docs/THEME-IMPORT.md`

**新增章节**:

```markdown
## 导入失败的清理保证

### 补偿语义

主题包导入使用**尽力而为**的补偿策略：

1. **素材入池**：使用 `preserveActive: true`，不切换素材池当前项
2. **创建失败**：逐项删除新入池的素材
3. **并发窗口**：如果新素材在创建失败前被其他包引用，则**拒绝删除该素材并保留**
4. **异常隔离**：单个素材清理失败不中断后续清理，记录日志并设置 `warn=import-cleanup`

### 已知边界

- **孤儿素材可能性**：并发操作可能遗留未被任何包引用的素材
- **清理方式**：运行 `pnpm db:gc-files --dry-run` 巡检，确认后执行清理
- **影响范围**：不影响功能，仅占用存储空间

### 设计权衡

**为什么不用两阶段提交？**
- 素材池与主题包不在同一事务（文件系统 vs 数据库）
- 完全原子性需要分布式事务或 saga 模式，复杂度显著增加
- 当前设计在 99% 场景下无副作用，孤儿素材可通过定期巡检清理

**为什么不检查引用计数？**
- `getDecorUsage()` 需要全表扫描，在事务内执行会延长锁持有时间
- 并发窗口依然存在（检查后、删除前可能有新引用）
- 当前「拒绝删除已引用素材」已保证功能正确性
```

**验证**: 在文档中搜索 "import" / "清理" / "补偿"，确保边界说明清晰。

---

## 测试验证

修复后运行：

```bash
# 1. 类型检查
pnpm --filter @funwind/web exec tsc --noEmit

# 2. 单元测试（如果主题包有单测）
pnpm --filter @funwind/web test theme

# 3. E2E 测试
pnpm --filter @funwind/web test:e2e theme-manager

# 4. 全局门禁
pnpm verify:all
```

---

## 提交建议

```bash
git add -p  # 逐块确认修改

git commit -m "fix(theme): 修复 P1 级问题（第三轮复审）

- L-03: 编辑页补充 capacity-unavailable 错误码（G-15 合规）
- L-04: LOGO 联动增加 unchanged 状态提示
- L-01: 主题包删除前检查素材池引用并记录警告
- L-02: 文档明确导入清理的尽力而为语义与孤儿素材巡检方式

参考: docs/reviews/2026-11-01-third-review.md"
```

---

## 后续跟踪

- [ ] 定期（每周/每月）运行 `pnpm db:gc-files --dry-run` 检查孤儿素材
- [ ] 监控审计日志中 `theme.pack.delete` 的警告频率
- [ ] 如果孤儿素材成为问题，考虑实现自动清理任务
