# FunWind 运维任务管线（funwind-ops）

职责分离的运维任务执行体（Python + FastAPI + APScheduler）：任务与触发器作为配置管理，管线读配置调度执行、
写运行台账。Next.js 后台只是管理入口，不承担执行逻辑。M14：管线内核与目录已统一更名为 `funwind-ops`（容器/镜像/项目名同名；备份卷
`funwind-backup-files` 与数据不动，D3）。设计与决策见 [M14 里程碑文档](../../docs/milestones/M14-ops-pipeline.md)。

## 与其他服务的交互设计（通信契约）

```
┌──────────────────────┐   X-OPS-Token          ┌───────────────────────────────┐
│ Next.js（/admin/ops） │ ── POST /tasks/{k}/runs ▶│ 运维任务管线                   │
│  · 写任务/触发器配置   │    （异步，返回 run_id）  │  · 读配置 → 登记触发器（APScheduler）│
│  · 读台账（只读）      │ ── POST /config/reload ▶│  · 执行器：mysqldump / tar …    │
│  · 下载（只读备份卷）  │ ◀─ JSON ─────────────── │  · GET_LOCK 互斥、写台账/状态     │
└──────────┬───────────┘                         └──────────────┬────────────────┘
           │ 配置表 ops_tasks / ops_triggers（web 写，Step 2 建表）  │ 读配置（周期对账兜底）
           │ 台账 ops_runs / 触发器状态 ops_trigger_state（管线写，web 只读）
           │ 备份卷 funwind-backup-files（管线读写；app 只读挂载）
```

- **配置与执行解耦**（M14 D1）：任务定义与触发器归 web（drizzle 配置表，后台写 + 审计）；管线启动时与每
  `OPS_RECONCILE_SECONDS`（默认 300s）读一次配置，web 保存后调 `POST /config/reload` 走快路径。配置内容
  不变不重登触发器。
- **零表韧性**：配置表不存在或为空 → 回落内置默认任务（数据库备份 03:10、存储备份 03:40，各带手动触发器；
  cron 可用 `BACKUP_DB_CRON` / `BACKUP_STORAGE_CRON` 覆盖）。配置项校验失败只跳过该项，原因见 `/health`
  的 `problems`。
- **台账**（M14 D7）：v1 的 `backup_runs` 启动时幂等改名为 `ops_runs` 并补 `task_key` 列（数据与 id 全保——
  恢复按 run id 定位备份）；`ops_trigger_state` 记每个触发器的下次/上次触发与最近结果，后台「下次运行」以它
  为准，web 不复算 cron。两张表都由管线自治建表，不进 drizzle schema。
- **鉴权**：管理类 API 要求 `X-OPS-Token`（常量时间比较；与 web 侧 `BACKUP_OPS_TOKEN` 同值）；
  `POST /restore` 另需 `confirm=true`，目标库名先过白名单。

## 任务配置模型

| 概念 | 说明 |
|---|---|
| 执行器（executor） | 代码里的注册表（`app/executors.py`）：`backup.db` / `backup.storage`，各自声明参数校验、互斥组、台账类别 |
| 任务（task） | 一个执行器 + 参数（如 `{"keep": 14}` 保留份数）+ 启停 |
| 触发器（trigger） | `cron`（5 段，**星期字段只认名称 `mon…sun`**）/ `once`（`YYYY-MM-DD HH:MM:SS` 北京时间，触发一次）/ `manual`（有它才允许后台手动触发） |

配置表列契约见 `tests/contract.py`（Step 2 的 drizzle 迁移必须与之一致）。保留份数优先级：任务参数 >
`site_settings("ops.backup.policy")`（后台旧设置区，Step 2 迁入任务参数后退役）> `BACKUP_KEEP_*` 环境默认。
恢复不是可调度任务（每次要指定源备份与目标库），走专用 API / CLI。

## API 契约

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /health | 无 | 健康 200 / 降级 503（缺必需配置、库不可达、尚未引导）；正文含 `scheduler_jobs`、`problems`、`missing_env` |
| GET | /tasks | Token | 任务与触发器清单（含下次/上次触发、最近结果） |
| POST | /tasks/{task_key}/runs | Token | **异步**手动触发：202 + `run_id`；404 无此任务、400 停用或无手动触发器、409 同组忙碌、503 降级 |
| POST | /config/reload | Token | 热加载通知（web 保存配置后调用；失败无妨，周期对账兜底） |
| GET | /runs?limit=50 | Token | 台账（倒序） |
| GET | /runs/{run_id} | Token | 单条运行记录（轮询异步触发进度用） |
| POST | /runs?kind=db\|storage | Token | **兼容期**同步触发（v1 语义，执行完才返回；web 切到异步端点后于 Step 6 移除） |
| POST | /restore?run_id=&target_db=&confirm=true | Token | 覆盖式恢复（目标库存在则先做安全 dump；只接受 db 备份） |

## CLI（容器内；与 API 同一执行器）

```sh
docker exec funwind-ops python cli.py status               # 配置来源、任务/触发器（含下次运行）、最近台账
docker exec funwind-ops python cli.py tasks                # 任务清单（JSON）
docker exec funwind-ops python cli.py runs 20
docker exec funwind-ops python cli.py run backup.db        # 立即同步执行一个任务
docker exec funwind-ops python cli.py backup db | storage  # 同上（v1 兼容写法）
docker exec funwind-ops python cli.py restore <run_id> [--target-db X] [--dry-run] [--yes]
```

## 运行韧性

- 缺 `BACKUP_DB_PASSWORD` / `OPS_TOKEN`：服务照常启动但停在降级态（`/health` 503 并点名缺失项，调度器不启动）——
  不再像 v1 那样 import 期崩溃，在 `restart: unless-stopped` 下崩溃循环。
- 库不可达：引导按 `OPS_BOOTSTRAP_RETRY_SECONDS`（默认 30s）重试，库恢复后自动就绪，无需重启容器。
- 进程中断残留：引导与每次周期对账把 running 超过 `OPS_STALE_RUN_MINUTES`（默认 120）的记录标记 failed。
- 日志：执行结果统一 `[ops] task=<键> trigger=<触发器> status=success|failed|skipped|queued run=<id>`，
  在 `docker logs` 里检索。

## 测试

```sh
cd services/ops
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m pytest                 # 单测 + 真实 MySQL 临时库集成（读仓库根 .env 的 NEW_DB_*；SKIP_DB_TESTS=1 跳过）

# 镜像内全量（含真实 mysqldump/mysql 的恢复链路测试；本机无 MySQL 客户端时这 5 项会跳过）
docker build -t funwind-ops:test . && docker run --rm \
  -v "$PWD/tests:/srv/tests:ro" -v "$PWD/pytest.ini:/srv/pytest.ini:ro" \
  -e OPS_TEST_DB_HOST=host.docker.internal -e OPS_TEST_DB_PORT=33621 -e OPS_TEST_DB_PASSWORD \
  funwind-ops:test sh -c "pip install -q pytest==8.3.4 httpx==0.27.2 && python -m pytest -p no:cacheprovider"

# 全链路冒烟（自建临时 MySQL 与目录，结束自动清理；部署前必跑）
docker build -t funwind-ops:smoke . && scripts/smoke-docker.sh funwind-ops:smoke
```

## 已知约束与教训

- 客户端必须用**官方 mysql:8.4 镜像内的 mysqldump/mysql**（alpine 的 mariadb-client 不带
  caching_sha2_password 插件，无法认证 MySQL 8.4）。
- 数据库口令经临时 option 文件（`--defaults-extra-file`，0600，用完即删）交给客户端，不出现在进程参数里。
- **cron 星期字段只认名称**：APScheduler 3.x 的 0 是周一（crontab 的 0 是周日），`from_crontab()` 不转换——
  数字写法会静默错位一天，管线直接拒绝。
- 保留轮转只匹配「前缀 + 时间戳数字」的常规备份；恢复前的安全 dump（`db-<库>-pre-restore-…`）不参与轮转
  （v1 曾因前缀相同而让安全 dump 挤占保留份数，M14 Step 1 修正）。- **备份源目录的顶层写入竞争**：tar 归档结束会重 stat 源目录顶层，期间顶层 mtime/ctime 变化即判
  「file changed」失败。生产曾因 web 健康探针每 30s 写删顶层探针文件而连续失败（M14 24h 核对发现，
  探针已改写 `.tmp/`——该目录在 tar 排除清单内）。**新增任何写 STORAGE_DIR 顶层的逻辑前，先核对
  管线 tar 的排除清单**。

- 引入服务内置调度器时，**必须同步撤掉旧的宿主机 crontab**——双定时线会让同一备份重复执行
  （GET_LOCK 保证无损但浪费）。
- 运维写库统一走本服务的 python 通道（参数化 SQL）；不要 ssh+mysql -e 手拼（多层引号转义会静默失配）。
- 脚本断言不要写「生产者 | grep -q」：grep 命中即退出，生产者撞 SIGPIPE，pipefail 下命中反被判失败；
  `$VAR` 后紧跟全角字符会被并进变量名，一律写 `${VAR}`。
