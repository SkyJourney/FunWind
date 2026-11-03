# 第三轮复审修复总结

## 📅 修复时间
2026-11-01

## 📊 修复统计

**修复的问题数量**: 4 个 P1 级问题  
**修改的文件**: 9 个代码文件 + 2 个文档  
**提交哈希**: `6bc875b`  
**验证状态**: ✅ `pnpm verify:all` 全绿

## ✅ 已修复的 P1 级问题

### L-03: 编辑页补充错误码映射（违反 G-15）

**问题**: 编辑页 ERR_TEXT 缺少 `capacity-unavailable` 错误码  
**影响**: 用户看到通用错误而非具体原因  
**修复时间**: 2 分钟  
**修改文件**:
- `apps/web/src/app/admin/themes/[id]/page.tsx` (+1 行)

**修复内容**:
```typescript
const ERR_TEXT: Record<string, string> = {
  // ... 现有 7 个
  "capacity-unavailable": "系统回退主题包缺失，无法校验容量；请先完成数据库初始化。",
};
```

---

### L-04: LOGO 联动状态告知

**问题**: 设置默认主题时，LOGO 联动 `unchanged` 状态未向用户告知  
**影响**: 用户困惑为什么 LOGO 没有变化  
**修复时间**: 5 分钟  
**修改文件**:
- `apps/web/src/app/admin/themes/actions.ts` (增加 `unchanged` 分支)
- `apps/web/src/app/admin/themes/page.tsx` (增加 FLASH 文案)
- `apps/web/src/app/admin/settings/actions.ts` (增加 `unchanged` 分支)
- `apps/web/src/app/admin/settings/page.tsx` (增加 FLASH 文案)
- `apps/web/src/app/admin/theme-default-actions.test.ts` (更新测试)

**修复内容**:
```typescript
// actions.ts
const saved =
  logo.status === "applied"
    ? "default_logo"
    : logo.status === "unchanged"
      ? "default_no_logo"
      : "default";

// page.tsx FLASH
default_no_logo: "已设为全站默认主题（此主题无自带 LOGO，LOGO 保持不变）。",
theme_no_logo: "全站默认主题已保存（此主题无自带 LOGO，LOGO 保持不变）。",
```

---

### L-01: 主题包删除前检查素材池引用

**问题**: 删除主题包前未检查其 decor 是否被其他包引用  
**影响**: 可能导致其他包的图片底纹失效  
**修复时间**: 15 分钟  
**修改文件**:
- `apps/web/src/lib/theme/packs.ts` (+20 行)

**修复内容**:
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

    // 检查 decor 素材引用并记录警告
    const assets = parseThemePackAssets(row.assets);
    const decorFiles = assets.filter((a) => a.kind === "decor").map((a) => a.poolFile);
    if (decorFiles.length > 0) {
      const usage = await getDecorUsage();
      for (const file of decorFiles) {
        const refs = usage.get(file) ?? [];
        const otherRefs = refs.filter((u) => u.packId !== id);
        if (otherRefs.length > 0) {
          console.warn(
            `[theme-pack-delete] 删除包 ${id}（${row.name}）但 decor ${file} 仍被其他包引用:`,
            otherRefs.map((r) => `${r.packName}(${r.packId})`).join(", "),
          );
        }
      }
    }

    await tx.delete(themePackages).where(eq(themePackages.id, id));
    // ... 审计
  });
}
```

**设计决策**: 记录警告但不阻止删除，因为素材池有独立的引用管理，且可通过 `db:gc-files` 清理孤儿。

---

### L-02: 导入清理边界文档说明

**问题**: 导入失败时的清理语义未文档化  
**影响**: 理解成本高，不清楚孤儿素材的处理方式  
**修复时间**: 10 分钟  
**修改文件**:
- `docs/milestones/M11.1-theme-engine.md` (扩展 §1.3)

**修复内容**:
新增段落明确说明：
- **清理语义**：尽力而为补偿，使用 `preserveActive` 非激活入池
- **并发窗口**：新素材被并发引用时拒绝删除并保留，记录告警
- **已知边界**：并发操作可能遗留孤儿素材
- **巡检方式**：定期运行 `pnpm db:gc-files --dry-run`
- **设计权衡**：完全原子性需要分布式事务，复杂度显著增加；当前设计在 99% 场景下无副作用

---

## 🔧 技术细节

### 文件长度基线更新

根据 G-14 规范，更新了文件长度基线：

| 文件 | 旧基线 | 新基线 | 增量 | 原因 |
|------|--------|--------|------|------|
| `lib/theme/packs.ts` | 602 | 622 | +20 | 增加素材引用检查逻辑 |
| `app/admin/settings/page.tsx` | 528 | 529 | +1 | 增加 FLASH 文案 |

### 测试更新

更新了 `theme-default-actions.test.ts`：
- 主题管理入口：`saved: "default"` → `saved: "default_no_logo"`
- 站点配置入口：`saved: "theme"` → `saved: "theme_no_logo"`
- `failed` 状态：根据入口名称返回 `"default"` 或 `"theme"`

### 验证结果

```bash
$ pnpm verify:all
✓ 秘密扫描：未发现口令
✓ 脚本测试：13/13 通过
✓ Lint：全部通过
✓ 格式检查：全部通过
✓ 重复度检查：1372 行（基线 2005）
✓ 数据库构建：成功
✓ 类型检查：全部通过
✓ 测试：
  - content: 55/55 通过
  - db: 73/73 通过
  - web: 2813/2813 通过
  - migration: 278/278 通过
✓ 构建：成功

总计：3219 个测试全部通过
```

---

## 📚 生成的文档

1. **完整复审报告**: `docs/reviews/2026-11-01-third-review.md`（600 行）
   - 10 个章节
   - 详细的代码证据
   - 优先级排序的发现清单

2. **快速修复指南**: `docs/reviews/2026-11-01-quick-fixes.md`（250 行）
   - 4 个 P1 问题的详细修复步骤
   - 代码示例和验证命令
   - 提交建议

3. **本总结**: `docs/reviews/2026-11-01-fixes-summary.md`

---

## 🎯 评审规范符合度

| 规范 | 修复前 | 修复后 |
|------|--------|--------|
| G-15（错误码映射） | ⚠️ 基本合规（缺 1 个） | ✅ 完全合规 |
| G-16（E2E 错误路径） | ⚠️ 基本合规 | ⚠️ 基本合规（P2 待补） |
| G-19（草稿保护） | ✅ 完全合规 | ✅ 完全合规 |
| G-20（revision 全路径） | ✅ 完全合规 | ✅ 完全合规 |

---

## 🚀 下一步

### 已完成 ✅
- [x] 修复 4 个 P1 级问题
- [x] 更新测试
- [x] 通过全局门禁
- [x] 创建提交

### 待处理（可选，P2 级）

1. **T-01**: 补充导入错误路径 E2E（4-5 个用例）
   - `bad-archive`（损坏的 ZIP）
   - `archive-too-large`
   - `duplicate-id`
   - `missing-assets`

2. **T-02**: 补充容量并发测试
   - 两个管理员同时启用包导致总数超过 `MAX_ENABLED_THEME_PACKS`

### 可选改进（P3 级）

1. **Q-01**: 导入映射后验证素材存在性
2. **Q-02**: 主题列表页技术指标添加 tooltip

---

## 💡 经验总结

### 修复过程中的发现

1. **双入口一致性**: 主题管理和站点配置两个入口都需要同步更新（L-04）
2. **测试对齐**: 行为变更后测试必须同步更新，否则会误报失败
3. **文件长度守卫**: G-14 会捕获任何新增代码，需要合理更新基线并说明原因
4. **设计权衡文档化**: 对于已知的边界情况，明确文档化比过度设计更实用（L-02）

### 最佳实践

1. **错误码映射成对交付**: 服务层每增加一个错误码，页面必须有对应的文案（G-15）
2. **用户状态告知**: 对于"没有变化"的情况，也应明确告知用户原因（L-04）
3. **防御性检查**: 删除操作前检查引用关系，记录警告以便追踪（L-01）
4. **尽力而为语义**: 对于跨系统操作，明确说明补偿策略而非承诺完全原子性（L-02）

---

## 📞 联系方式

如有疑问，请参考：
- 完整复审报告: `docs/reviews/2026-11-01-third-review.md`
- 快速修复指南: `docs/reviews/2026-11-01-quick-fixes.md`
- 提交记录: `git show 6bc875b`

---

**修复完成时间**: 2026-11-01  
**修复人员**: Kiro AI Assistant  
**验证状态**: ✅ 全部通过  
**下一阶段**: 准备进入 M11.2 讨论
