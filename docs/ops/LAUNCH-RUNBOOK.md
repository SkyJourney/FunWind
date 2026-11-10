# FunWind · 上线演练与切换 RUNBOOK（M13 Step 6）

> 执行人：站长（Step 7）。AI 配合远程排查与文档回写。
> 纪律：**两次演练通过（含一次回滚）之前，不做正式切换**。每步都有回滚口。
> 配套文档：`docs/ops/BACKUP.md`（备份/恢复/退役序列数据口径）、`docs/ops/OBSERVABILITY.md`
> （拨测/告警）、`docs/milestones/M13-launch.md`（决策与门禁）。

## 0. 服务器目录布局（一次性准备）

```
/opt/funwind/
├── app/                # 应用编排
│   ├── compose.yaml    #   docker/production/compose.yaml
│   ├── .env            #   生产 env（docker/production/.env.example 填充，chmod 600）
│   └── scripts/backup/ #   仓库 scripts/backup/*.sh（crontab 用；M14 起退役——调度归 funwind-ops）
├── ops/                # 运维任务管线编排（M14，附录 §6；原 backup/ 旧栈停用后可归档）
│   ├── compose.yaml    #   docker/ops/compose.yaml
│   └── .env            #   BACKUP_DB_PASSWORD / OPS_TOKEN（chmod 600，不入库）
├── mysql/
│   ├── compose.yaml    #   docker/mysql/compose.yaml
│   └── .env            #   MYSQL_ROOT_PASSWORD=<强口令>（chmod 600）
├── nginx/
│   ├── funwind-redirect-map.conf   # docker/production/nginx/redirect-map.conf
│   └── funwind.conf               # docker/production/nginx/funwind.conf（切换时才启用）
└── backups/            # mysql/ storage/ legacy/ + backup.log
```

准备命令（本机 → 服务器）：

```sh
# ① 镜像（CI 无部署 job，D6：本机构建 → ssh load）
docker build -f docker/production/Dockerfile -t funwind-web:latest .
docker save funwind-web:latest | ssh QY_HK 'docker load'
ssh QY_HK 'docker tag funwind-web:latest funwind-web:$(date +%Y%m%d) && docker images funwind-web'

# ② 配置与脚本（scp 目录布局上述文件；两份 .env 由站长在服务器上手工创建/填充）

# ③ 宝塔侧：redirect-map 上传为 /www/server/panel/vhost/nginx/funwind-redirect-map.conf
#    （map 是 http 层 include——现在就可以放，不影响旧站；funwind.conf 切换时才覆盖 vhost）
scp docker/production/nginx/redirect-map.conf QY_HK:/www/server/panel/vhost/nginx/funwind-redirect-map.conf
```

## 1. 演练一 · 容器与迁移全链路（不动旧站，随时可弃）

> 目标：在真实服务器上验证「镜像能起、迁移能把真实旧库搬进新 MySQL、品牌初始化、应用可读」。
> 全程旧站不受影响（MySQL 用 13306 避让、app 只绑 loopback:3311、不动宝塔 vhost）。

```sh
# ① MySQL 独立编排（演练端口 13306；数据库先建空库）
ssh QY_HK 'cd /opt/funwind/mysql && MYSQL_HOST_PORT=13306 docker compose --env-file .env up -d'
ssh QY_HK 'docker exec funwind-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" \
  -e "CREATE DATABASE IF NOT EXISTS qingyisub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"'

# ② 真实迁移（主路径：本机迁移经 SSH 隧道在线读旧 MariaDB；详见 migration/README.md）
ssh -fNL 33620:127.0.0.1:3306 QY_HK          # 隧道：本机 33620 → 服务器 MariaDB
#   本机 .env 临时改：OLD_DB_HOST=127.0.0.1 OLD_DB_PORT=33620
#   NEW_DB_* 指向服务器演练库（NEW_DB_HOST=<服务器IP> 需 MySQL 临时开外网访问——改用隧道二段：
ssh -fNL 33621:127.0.0.1:13306 QY_HK         # 第二条隧道：本机 33621 → 服务器演练 MySQL
#   NEW_DB_HOST=127.0.0.1 NEW_DB_PORT=33621 NEW_DB_NAME=qingyisub
pnpm migrate            # 导入（幂等 UPSERT；检测到线上数据会拒——演练库是空库，安全）
pnpm verify:migration   # 对账（600 行抽样 MD5 全对）

# ③ 上线检查单（导入路径：users 非空，向导不参与）
NEW_DB_PORT=33621 pnpm init-brand   # 默认站标（幂等，重跑显示"跳过"）

# ④ 应用容器起（app/.env 的 NEW_DB_PORT 填 13306——容器在 funwind-internal 网络内经容器名直连
#    funwind-mysql:3306，端口映射只影响宿主侧；此处 13306 仅供迁移隧道用）
ssh QY_HK 'cd /opt/funwind/app && docker compose --env-file .env up -d'
ssh QY_HK 'curl -s http://127.0.0.1:3311/api/health'   # 期望 {"status":"ok",...}

# ⑤ 目视验收（本机浏览器）
ssh -L 3311:127.0.0.1:3311 QY_HK
#   浏览器开 http://127.0.0.1:3311：顶栏品牌、首页、抽样旧帖直达、登录/找回页可达
```

**演练一验收**：health ok；对账全过；品牌在位；抽样 10 条旧帖（记下 tid）在演练环境渲染正常。
**回滚口**：`ssh QY_HK 'cd /opt/funwind/app && docker compose down; cd /opt/funwind/mysql && docker compose down'`
（演练数据卷保留可复跑；彻底重来 `docker volume rm funwind-mysql-data`）。
**问题记录**：任何一步失败 → 记录到 M13 文档 §9，修复后演练一重跑（迁移/品牌全部幂等）。

## 2. 演练二 · 切换彩排（含停旧栈与回滚，在约定窗口内执行）

> 目标：把「正式切换」完整走一遍并演练一次回滚。窗口内站点短暂停写（提前公告）。
> 演练二与正式切换的唯一区别：结尾回滚，不发送召回、不发公告。

```sh
# ① 停写 + 旧库归档（BACKUP.md §5）
ssh QY_HK "mysqldump -uroot -p'<旧库口令>' --default-character-set=utf8mb4 --single-transaction \
  --routines --triggers qingyisub | gzip > /opt/funwind/backups/legacy/legacy-final-drill-\$(date +%Y%m%d-%H%M).sql.gz"

# ② 停旧栈（3306 腾出）：MariaDB + php-fpm + 旧 vhost（数据/目录一律不删）
ssh QY_HK 'systemctl stop mysqld php-fpm-56 php-fpm-83
  cp /www/server/panel/vhost/nginx/www.qingyisub.top.conf{,.bak-$(date +%Y%m%d)}
  # 旧站 vhost 改名停用（nginx 不再加载）：
  mv /www/server/panel/vhost/nginx/www.qingyisub.top.conf /www/server/panel/vhost/nginx/www.qingyisub.top.conf.disabled
  nginx -t && nginx -s reload'

# ③ MySQL 接管 3306（正式端口）+ 迁移到正式库
ssh QY_HK 'cd /opt/funwind/mysql && docker compose --env-file .env up -d'   # 不再设 MYSQL_HOST_PORT
#   迁移：重跑 pnpm migrate（隧道重建指向 3306；幂等）→ verify:migration

# ④ 宝塔 vhost 切换：funwind.conf 内容覆盖为 www.qingyisub.top.conf（证书路径已对齐）
ssh QY_HK 'cp /opt/funwind/nginx/funwind.conf /www/server/panel/vhost/nginx/www.qingyisub.top.conf
  nginx -t && nginx -s reload'

# ⑤ 冒烟：health / 301 / 旧帖抽样
curl -s https://www.qingyisub.top/api/health
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "https://www.qingyisub.top/read.php?tid=<抽样tid>"
#   app/.env 确认 TRUSTED_PROXY_HOPS=1 / APP_URL=https://www.qingyisub.top；改过则重启 app 容器

# ⑥ ★回滚演练★（演练二必做）：恢复旧 vhost + 旧栈
ssh QY_HK 'mv /www/server/panel/vhost/nginx/www.qingyisub.top.conf{.disabled,}  # 恢复旧 vhost
  systemctl start mysqld php-fpm-56 php-fpm-83
  nginx -t && nginx -s reload
  cd /opt/funwind/app && docker compose stop app'
curl -s -o /dev/null -w "旧站恢复：HTTP %{http_code}\n" https://www.qingyisub.top/   # 旧站应 200
#   再把旧栈停掉、vhost 切回新站——演练二第 ③–⑥ 步再来一遍，确认切换动作可重复。
```

**演练二验收**：301 抽 20 条全绿；health ok；回滚 ≤5 分钟内旧站恢复；重切成功。
（此时 MySQL 编排已接管 3306——回滚口里 `systemctl start mysqld` 会端口冲突：先
`cd /opt/funwind/mysql && docker compose stop` 再起 MariaDB。演练时实测确认此细节。）

## 3. 正式切换日动作序列（演练两次通过后执行）

> 窗口：站点未开放时段。全程参照演练二第 ①–⑤ 步（已验证过的命令原样执行），外加运营动作。

1. **预置**（窗口前）：公告草稿、邀请码批次（后台 `/admin` 生成）、召回名单复核
   （`pnpm recall-blast` dry-run 输出 10679 可发截图留档）。
2. 停写 + 旧库归档（同演练二 ①②）。
3. MySQL 接管 3306 → 迁移 → `verify:migration` 全过 → `pnpm init-brand`（幂等核对）。
4. vhost 切换（301 映射生效）→ `health` ok → **旧帖抽样 20 条直达** → 本机目视（顶栏品牌/favicon/公告位）。
5. **公告发布**（后台公告功能）+ 邀请码批次上线（注册策略 = 邀请制，D1 默认）。
6. **召回发送**：`pnpm recall-blast --apply`（≈300 封/分钟，1.07 万约 36 分钟；进度行实时输出；
   失败行事后按 email_log scene=recall-relaunch status=failed 排查补发——重跑只补失败者）。
7. 拨测/告警确认（OBSERVABILITY.md §2 已在上线后第一时间验证触达）。
8. 观察期 24h：`docker logs funwind-app` 无持续 error、digest 次日到达、CSP 违规报告量正常
   （`/api/csp-report` 日志）、备份 crontab 次日首跑核对产物。

## 4. 多实例检查单处置记录（G-17/G-18，M13 处置=记录）

| # | 项 | 处置 |
|---|---|---|
| 1 | 限流/上传并发闸/浏览量计数共享存储 | **单实例语义维持**（`lib/auth/ratelimit.ts`、`lib/views/counter.ts`）——改拓扑前必须换 Redis/DB |
| 2 | authz 快照失效通道（globalThis） | **单实例语义维持**（`lib/authz/snapshot.ts`） |
| 3 | outbox 自愈巡检迁调度器 | **候选，未做**（`lib/events/outbox.ts`；手动 `pnpm outbox:drain` 兜底） |
| 4 | THEME_PREVIEW_SECRET 显式一致 | **单实例无需**；多实例前必须显式配置（G-17-4） |
| 5 | 跨实例缓存收敛（主题目录/emoji 30–60s TTL） | **单实例可接受** |
| 6 | G-18 集合规模 ≤5 | **核对通过**（导入器不写 theme_packages） |
| 7 | 先 db:bootstrap 再部署 | **操作项**：已并入迁移管线（bootstrapDb 幂等，migrate 前置）；升级发布时 `pnpm db:bootstrap` 后再换容器 |
| 8 | M13-1…M13-7 配置动作 | TRUSTED_PROXY_HOPS=1（app/.env）✓；client_max_body_size 64m（funwind.conf）✓；旧会话核对（M13-4 设计语义一致）✓；孤儿文件巡检 `pnpm db:gc-files`（月度）✓；对象存储=记录不迁移 ✓；HTTP 基准（部署环境补测，可选） |

## 5. 已知差异与注意事项

- 宝塔 vhost 旧 conf 的 TLSv1.1 已在新 conf 移除（现代基线）；QUIC/Alt-Svc 保留需宝塔 quic 模块——
  新 conf 保留 `listen 443 quic`，若 reload 报错可删该行（TLS 部分不受影响）。
- `well-known`（证书续期）include 路径沿用旧 conf；证书续期任务（宝塔计划任务）不受切换影响。
- MySQL 数据卷 `funwind-mysql-data` 为 named volume：**宿主机直备**走 `docker run --rm -v funwind-mysql-data:/data alpine tar ...`
  或按 BACKUP.md 用 mysqldump（推荐）；删除卷 = 不可逆，签字前不删任何旧栈数据。
- 阿里云安全组：确认 443/80 开放、3306 **不对公网**（仅 loopback + funwind-internal 网络）。

## 6. M14 升级：运维任务管线（funwind-backup → funwind-ops，2026-11-10）

> 公测期原地升级：换 web 容器一次（中断 < 1 分钟），管线无状态可随时重启。
> 前置门禁：仓库内 verify:all / 全量 E2E / 安装 E2E / visual / layout / perf 全绿 + 本机 compose
> 全链路实测（见 M14 文档 §执行记录）。审查报告：`docs/reviews/2026-11-10-m14-code-review.md`。

### 6.0 前置核对（防呆，R-21 教训）

- **卷名核对**：`docker/ops/compose.yaml` 的备份卷显式名必须是 `funwind-backup-files`（与服务器现存
  卷同名——更名曾误改成 funwind-ops-files，挂到空卷会让旧备份全部「消失」）。
  `BACKUP_DB_PASSWORD=x OPS_TOKEN=x docker compose -f docker/ops/compose.yaml config | grep -A3 volumes`。
- **token 同值对账**（R-7）：`OPS_API_TOKEN`（app/.env）与 `OPS_TOKEN`（ops/.env）必须同值——用同一条
  `openssl rand -base64 24` 输出写入两处，从来源上消灭双名漂移。

### 6.1 本机 → 服务器（镜像与编排文件）

```sh
docker build -f docker/production/Dockerfile -t funwind-web:latest .
docker build -t funwind-ops:latest services/ops
docker save funwind-web:latest | ssh QY_HK 'docker load'
docker save funwind-ops:latest  | ssh QY_HK 'docker load'
ssh QY_HK 'docker tag funwind-web:latest funwind-web:$(date +%Y%m%d) && docker tag funwind-ops:latest funwind-ops:$(date +%Y%m%d) && docker images | grep -E "funwind-(web|ops)"'
scp docker/production/nginx/funwind.conf QY_HK:/opt/funwind/nginx/funwind.conf
ssh QY_HK 'mkdir -p /opt/funwind/ops'
scp docker/ops/compose.yaml QY_HK:/opt/funwind/ops/compose.yaml
```

### 6.2 服务器侧（顺序执行，每步可核）

1. **nginx 封禁先行**（内部接口三保险之①，先于新 web 上线）：确认 conf 含
   `location /api/internal/ { return 404; }` → `nginx -t` → reload；核对
   `curl -s -o /dev/null -w '%{http_code}' https://www.qingyisub.top/api/internal/x` = 404。
2. **app/.env** 追加 `OPS_API_TOKEN=<6.0 生成的同值>`（chmod 600 保持）。
3. **ops/.env** 新建：`BACKUP_DB_PASSWORD=<与 mysql/.env 同值>`、`OPS_TOKEN=<同值>`（chmod 600）。
4. **迁移与种子（换容器前，G-17-7）**：本机隧道 `ssh -fNL 33620:127.0.0.1:3306 QY_HK` →
   `NEW_DB_HOST=127.0.0.1 NEW_DB_PORT=33620 NEW_DB_NAME=qingyisub NEW_DB_PASSWORD=<root 口令> pnpm db:bootstrap`
   （迁移 0025/0026 + ops_tasks 首写种子，幂等，重复跑无害）。
5. **停旧管线**（防双调度——新旧锁名不同，不 down 会并行双备份）：
   `ssh QY_HK 'cd /opt/funwind/backup && docker compose down'`（容器 funwind-backup；卷与数据不动）。
6. **换 web**：`ssh QY_HK 'cd /opt/funwind/app && docker compose up -d'`（load 的新镜像即被拾取）。
7. **起新管线**：`ssh QY_HK 'cd /opt/funwind/ops && docker compose up -d'`
   （容器 funwind-ops：启动幂等把 backup_runs 演进为 ops_runs + 建 ops_trigger_state，id 连续保留）。

### 6.3 部署后核对

- **即时**：`/api/health` ok；`/admin/ops` 任务清单 4 任务、管线「运行中」；手动触发一次数据库备份 →
  台账 running → success（5s 轮询自动刷新）；`docker exec funwind-ops python cli.py status` 与后台一致；
  `/api/internal/x` 公网 404；管线 API 无/错 token 均 401。
- **当天**：ops_trigger_state 出现四个下次触发时间（03:10 / 03:40 / 09:00 / 周五 02:00）；
  无 failed 行 → ops.alerts 不产生告警。
- **24h**：两条备份 cron 首跑成功且文件落卷；`docker exec funwind-ops python cli.py runs 20` 与后台
  台账一致；服务器磁盘容量正常（存储备份单份约 95MB × keep 7）。

### 6.4 回滚口径

- **回退 web**（旧镜像 funwind-web:<日期戳>）：compose up 换回；旧代码读 `BACKUP_SERVICE_URL` /
  `BACKUP_OPS_TOKEN`——app/.env 临时补 `BACKUP_SERVICE_URL=http://funwind-ops:8000`（容器名未变，
  新管线继续可被触发）；/admin/ops 读不到 ops_runs → 降级空态（F12/R-4 已做实，不再 500）。
- **回退管线**（旧镜像 funwind-backup:<日期戳>）：`cd /opt/funwind/backup && docker compose up -d`
  （先 down 新 ops 防双调度）；旧管线启动 `CREATE IF NOT EXISTS backup_runs` 按旧语义继续备份；
  `ops_runs` / `ops_trigger_state` 数据保留，升级回来幂等续用（id 连续不破坏）。
- **配置表**：ops_tasks/ops_triggers 回滚后无消费者（旧管线不读），留着无害；迁移不做反向删除。
- **节日装扮最坏情况** = 生成失败（台账 failed + 站内告警），不破坏生效语义（生效由 campaigns
  读取时判定）。
