# FunWind · 青翼字幕组（QYSUB）新论坛

> 抛弃 phpwind 9.0，全新开发的现代化论坛系统。
> 旧程序与旧库只作内容源与业务逻辑参考，代码零复用。
> 青翼字幕组：日语/ACG 字幕组情怀社区（www.qingyisub.top），1,472 个真实主题、35,248 条回复、10,701 名用户、25 枚勋章、93,765 条积分流水。

- **当前进度**：P0 数据迁移 ✅ → **P1 论坛 MVP（M1 工程骨架）进行中**
- **开发方式**：里程碑制，见 [docs/ROADMAP.md](docs/ROADMAP.md)（每里程碑有明确范围、边界、测试规则与验收门禁）

## 文档索引

| 文档 | 内容 |
|------|------|
| [docs/BLUEPRINT.md](docs/BLUEPRINT.md) | 技术蓝图：架构、新旧表映射、实测发现、全部已确认决策 |
| [docs/LEGACY-FEATURE-MAP.md](docs/LEGACY-FEATURE-MAP.md) | 旧源码↔新模块对齐报告（M01–M15 模块编号、57 权限点清单、骨架插入点）——新功能落地前先查它 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 里程碑路线图（M1–M12）、依赖关系、全局测试基线与完成定义 |
| [docs/FRONTEND-DESIGN.md](docs/FRONTEND-DESIGN.md) | 前端与主题系统：三层设计令牌、主题包、shadcn/ui 模式、响应式 |
| [docs/AUTHZ.md](docs/AUTHZ.md) | 权限模型：自研 RBAC/ABAC、5 表设计、旧数据翻译 |
| [docs/milestones/](docs/milestones/) | 里程碑详单（范围/边界/测试/门禁） |
| [CHANGELOG.md](CHANGELOG.md) | 变更日志 |

## 技术栈（已确认）

Next.js（最新版，App Router/RSC）+ TypeScript 严格模式 · Tailwind CSS v4 + 三层设计令牌 · shadcn/ui 模式组件 ·
Drizzle ORM · **MySQL 8.4 LTS**（utf8mb4, InnoDB）· 自研轻量 RBAC/ABAC · 模块注册表插件化 · Docker Compose

## 快速开始（当前阶段：迁移与数据库）

```bash
# 0. 环境要求：Node 24+、Docker Desktop、本机 33620/33621 端口空闲

# 1. 新库容器（MySQL 8.4 @ 127.0.0.1:33621/qysub_next）
docker compose -f docker/qysub-next/compose.yaml up -d

# 2. 迁移程序
cd migration
cp .env.example .env        # 填入真实口令（见下表）
npm install
npm run schema              # 初始化表结构（幂等）
npm run migrate             # 全量迁移（幂等，可重跑；-- users threads 可指定实体）
npm run verify              # 23 项对账验证（行数/MD5/转换完整性/垃圾标记/附件磁盘/楼层）
```

应用本体自 M1 起在本仓库逐步落地（启动命令随 M1 里程碑补充）。

## 环境速查

| 资源 | 地址 | 凭据 |
|------|------|------|
| 旧库（**只读红线**） | `127.0.0.1:33620/qingyisub`（GBK，mysql 5.7） | 见 `.env`（迁移程序内置只读守卫，非 SELECT 直接抛错） |
| 新库 | `127.0.0.1:33621/qysub_next`（MySQL 8.4） | root / ***REMOVED***（本地开发） |
| 旧站本地还原 | http://127.0.0.1:8080 | qingyisub-nginx 容器 |
| 附件目录 | `…/www.qingyisub.top/attachment/`（527MB，只读引用） | 新系统静态路由 `/attachment/**` |
| 表情目录 | 同上 `res/images/emotion/` | 新系统静态路由 `/emotion/**` |

## 核心约定

1. **旧库只读**：仅 SELECT/SHOW/DESC，代码层守卫强制。
2. **保留旧主键**（uid/tid/pid/fid/aid）：旧 URL 可精确 301，附件路径天然可用；每表 `raw JSON` 归档旧行。
3. **正文双写**：`content_raw`（原始 UBB）+ `content_md`（Markdown），永远可回滚。
4. **垃圾只标记不删除**：`is_spam=1` 默认隐藏、可审计可恢复；密码不迁移（邮件重置召回）。
5. **先骨架后功能**：模块注册表（事件总线/UI 槽位/权限点/导航/令牌覆盖）在骨架期就位，功能逐模块插入。

## 里程碑工作流

1. 从 [docs/ROADMAP.md](docs/ROADMAP.md) 领取当前里程碑 → 打开 `docs/milestones/Mx-*.md`。
2. 开发严格按「范围」推进，不越「边界」。
3. 完成定义（DoD）：里程碑文档中验收门禁 checklist 全部通过 + CHANGELOG 记录 + 相关文档同步更新。
4. 门禁不过不合并；测试规则见 ROADMAP「全局测试基线」。
