# FunWind 备份服务（funwind-backup）

职责分离的备份/恢复执行体（Python + FastAPI + APScheduler）。Next.js 后台只是管理入口
（查 `backup_runs` 表 + 触发 + 下载），不承担备份执行逻辑。

## 与其他服务的交互设计（通信契约）

```
┌──────────────────────┐   X-OPS-Token      ┌──────────────────────────┐
│ Next.js（/admin/ops） │ ── POST /runs ───▶ │ 备份服务（funwind-backup）│
│  · 查 backup_runs 表  │   （手动触发）      │  · APScheduler cron 定时  │
│  · 触发（管理入口）    │ ◀─ JSON 结果 ───── │  · mysqldump/tar + 轮转  │
│  · 下载（只读备份卷）  │                    │  · GET_LOCK 互斥          │
└──────────┬───────────┘                    └──────────┬───────────────┘
           │ 只读挂载 funwind-backup-files              │ 读写挂载（主写方）
           ▼                                           ▼
           └──────── 备份卷（db/*.sql.gz、storage/*.tgz）────────┘
           │ 读 backup_runs（web）/ 写（backup 服务）──▶ MySQL backup_runs 表
           │ backup 源 = funwind-storage 卷（只读挂载）
```

- **元数据**：`backup_runs` 表由本服务**自治建表与写入**（trigger cron/manual、状态、产物路径、
  大小、错误）；web 侧用原生 SQL **只读**查询（`lib/ops/backup.ts`），不进 drizzle schema
  （运维表归备份服务管，schema-rules 不约束）。
- **鉴权**：全部管理类 API 要求 `X-OPS-Token`（与 Next 侧 `BACKUP_OPS_TOKEN` 同值）；
  `POST /restore` 额外要求 `confirm=true` 双确认（覆盖式恢复）。
- **共享卷**：`funwind-backup-files`（本服务读写；app 只读挂载 `/data/backups` 提供
  `/admin/ops/download` 下载）；备份源 `funwind-storage` 只读挂载（app 的 STORAGE_DIR 同卷）。

## API 契约

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /health | 无 | 服务健康 + 调度任务清单（compose healthcheck 用） |
| GET | /runs?limit=50 | X-OPS-Token | 备份/恢复记录（倒序） |
| POST | /runs?kind=db\|storage | X-OPS-Token | 立即备份；409 = 已有任务在执行 |
| POST | /restore?run_id=&target_db=&confirm=true | X-OPS-Token | 覆盖式恢复（恢复前自动对目标库 dump 现场） |

## CLI（容器内；等价能力）

```sh
docker exec funwind-backup python cli.py status
docker exec funwind-backup python cli.py runs 20
docker exec funwind-backup python cli.py backup db | storage
docker exec funwind-backup python cli.py restore <run_id> [--target-db X] [--dry-run] [--yes]
```

## 保留策略（动态）

份数优先读 `site_settings("ops.backup.policy")`（`{"keepDb": n, "keepStorage": n}`，后台
`/admin/ops` 设置区可改，**保存即生效**——每次备份轮转时动态读取）；无记录/非法时回落
`BACKUP_KEEP_DB=14` / `BACKUP_KEEP_STORAGE=7`。手动与定时同池参与轮转。

## 已知约束与教训

- 客户端必须用**官方 mysql:8.4 镜像内的 mysqldump/mysql**（alpine 的 mariadb-client 不带
  caching_sha2_password 插件，无法认证 MySQL 8.4）。
- 引入服务内置调度器时，**必须同步撤掉旧的宿主机 crontab**——双定时线会让同一备份重复执行
  （GET_LOCK 保证无损但浪费）。
- 运维写库统一走本服务的 python 通道（参数化 SQL）；不要 ssh+mysql -e 手拼（多层引号转义
  会静默失配，2026-11-09 教训）。
