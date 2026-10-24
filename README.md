# FunWind · 青翼字幕组（QYSUB）新论坛

> 抛弃 phpwind 9.0，全新开发的现代化论坛系统。
> 旧程序与旧库只作内容源与业务逻辑参考，代码零复用。
> 青翼字幕组：日语/ACG 字幕组情怀社区（www.qingyisub.top），1,472 个真实主题、35,248 条回复、10,701 名用户、25 枚勋章、93,765 条积分流水。

- **当前进度**：P0 数据迁移 ✅ → 阶段一 M1–M5 ✅ → **M5.5 重构里程碑（设计先行：目标模型 v2.1 / 迁移适配层）重做中，R1 文档阶段** → M6 发帖与内容生产
- **开发方式**：里程碑制，见 [docs/ROADMAP.md](docs/ROADMAP.md)（每里程碑有明确范围、边界、测试规则与验收门禁）

## 文档索引

| 文档 | 内容 |
|------|------|
| [docs/BLUEPRINT.md](docs/BLUEPRINT.md) | 技术蓝图：架构、新旧表映射、实测发现、全部已确认决策 |
| [docs/DESIGN-MODEL.md](docs/DESIGN-MODEL.md) | **目标数据模型 v2.1（43 表）与设计原则**——数据模型的单一设计依据；旧数据向它靠拢 |
| [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | 通知中心：分类、数据模型、类型目录、注册边界、读取契约、铃铛交互 |
| [docs/LEGACY-FEATURE-MAP.md](docs/LEGACY-FEATURE-MAP.md) | 旧源码↔新模块对齐报告（M01–M15 模块编号、57 权限点清单、骨架插入点）——新功能落地前先查它 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 里程碑路线图（M1–M13）、依赖关系、全局测试基线与完成定义 |
| [docs/FRONTEND-DESIGN.md](docs/FRONTEND-DESIGN.md) | 前端与主题系统：三层设计令牌、主题包、shadcn/ui 模式、响应式 |
| [docs/AUTHZ.md](docs/AUTHZ.md) | 权限模型：自研 RBAC/ABAC；§1–§7 为 M5 实现，**§8 为 M5.5 修订（目标态）** |
| [docs/GATES.md](docs/GATES.md) | 门控规范：`:::gate` 容器指令、隐藏内容拆分存储、可插拔解锁条件、解锁事务 |
| [docs/POINTS.md](docs/POINTS.md) | 积分规范：用户积分台账、`applyPoints` 单一入口、渠道注册 |
| [docs/MODULES.md](docs/MODULES.md) | 模块内核契约：事件清单、槽位清单、注册边界 |
| [docs/milestones/](docs/milestones/) | 里程碑详单（范围/边界/测试/门禁） |
| [CHANGELOG.md](CHANGELOG.md) | 变更日志 |

## 技术栈（已确认）

Next.js 16（App Router/RSC）+ React 19 + TypeScript 严格模式 · Tailwind CSS v4 + 三层设计令牌 · shadcn/ui 模式组件 ·
Drizzle ORM · **MySQL 8.4 LTS**（utf8mb4, InnoDB）· 自研轻量 RBAC/ABAC · 模块注册表插件化 · Docker Compose ·
**pnpm workspace**（apps/web + packages/db + migration）

## 快速开始

```bash
# 0. 环境要求：Node 24+、pnpm 12（corepack/全局）、Docker Desktop

# 1. 安装依赖（workspace 一次装齐）
pnpm install

# 2. 新库容器（MySQL 8.4 @ 127.0.0.1:33621/qysub_next）
docker compose -f docker/qysub-next/compose.yaml up -d

# 3. 环境变量（数据库连接等）
cp .env.example .env        # 填入口令（见下表）

# ── 数据层双模式（决策 #10）：二选一或先 A 后 B ──
# A. 零数据部署路径：空库建表 + 可选演示种子
pnpm db:bootstrap           # 空库建表（Drizzle 版本化迁移，幂等）
pnpm db:seed                # 演示数据（90000+ 号段，幂等，仅开发用；生产环境或库里有真实用户时拒绝，须 --force）
# B. 青翼导入路径（可选）：phpwind 旧库 → qysub_next
pnpm migrate                # 全量导入（幂等，可重跑）
pnpm verify:migration       # 110 项对账（行数/MD5/转换完整性/垃圾标记/附件/楼层/计数）+ 渲染与保真硬门禁

# 4. schema 对账（information_schema 逐表比对 + 结构完整性 + 缓存计数，任何路径后都建议跑）
pnpm db:verify
pnpm db:recount             # 重算全部缓存计数（幂等）；--check 只读，有漂移时非零退出

# 5. 应用
pnpm dev                    # http://127.0.0.1:3100（令牌演示页 + 明暗切换）

# 质量门禁
pnpm verify:all             # lint + format + typecheck + test(+coverage) + build
pnpm test:e2e               # Playwright（chromium）
```

> ⚠️ Next 16 开发服务器需 `allowedDevOrigins` 放行 `127.0.0.1`（已在 `apps/web/next.config.ts` 配置），
> 否则开发资源被安全默认拦截、页面可渲染但无交互。

## 环境速查

| 资源 | 地址 | 凭据 |
|------|------|------|
| 应用（开发） | http://127.0.0.1:3100 | `pnpm dev` |
| 旧库（**只读红线**） | `127.0.0.1:33620/qingyisub`（GBK，mysql 5.7） | 见 `.env`（迁移程序内置只读守卫，非 SELECT 直接抛错） |
| 新库 | `127.0.0.1:33621/qysub_next`（MySQL 8.4） | root / 口令见根 `.env` 的 `NEW_DB_PASSWORD`（不入库） |
| 旧站本地还原 | http://127.0.0.1:8080 | qingyisub-nginx 容器 |
| 附件目录（旧站） | `…/www.qingyisub.top/attachment/`（527MB，只读） | 仅作迁移来源；新系统经 `/files/**` 提供（迁入内容寻址存储） |
| 表情目录（旧站） | 同上 `res/images/emotion/` | 迁移期已展开为 `/emoji/{id}.gif` 静态图 |

## 核心约定

1. **旧库只读**：仅 SELECT/SHOW/DESC，代码层守卫强制。
2. **只保留 URL 必须稳定的旧主键**（uid/fid/tid/pid）：旧 URL 可精确 301；其余 id 自增。（M5.5 起业务表不再带 `raw JSON` 归档列；旧库保持只读至 M13 签字，即为归档。）
3. **正文只留 Markdown**：M5.5 起业务表仅存 `body_md`，不再双写 `content_raw`；保真靠迁移对账（源库正文 md5 抽样）。门控隐藏内容拆入独立表。
4. **垃圾只标记不删除**：`is_spam=1` 默认隐藏、可审计可恢复；密码不迁移（邮件重置召回）。
5. **先骨架后功能**：模块注册表（事件总线/UI 槽位/权限点/导航/令牌覆盖）在骨架期就位，功能逐模块插入。
6. **数据层双模式**：schema 单一事实源在应用侧（Drizzle，`npm run db:bootstrap` 空库建表 + `db:seed` 演示种子），
   项目可**零数据安装部署**（Web 安装向导 + CLI，见里程碑 M12）；
   青翼 phpwind 导入（`migration/`）只是可选路径，运行不依赖旧库。

## 里程碑工作流

1. 从 [docs/ROADMAP.md](docs/ROADMAP.md) 领取当前里程碑 → 打开 `docs/milestones/Mx-*.md`。
2. 开发严格按「范围」推进，不越「边界」。
3. 完成定义（DoD）：里程碑文档中验收门禁 checklist 全部通过 + CHANGELOG 记录 + 相关文档同步更新。
4. 门禁不过不合并；测试规则见 ROADMAP「全局测试基线」。
