# FunWind 备份服务（funwind-backup）

职责分离的备份/恢复执行体：cron 定时 + HTTP API + CLI。Next.js 后台只是管理入口
（查 `backup_runs` 表 + 触发 + 下载），不再承担备份执行逻辑。

- 备份：DB（容器内 mysqldump→gzip）/ storage（源存储卷 tar→gzip），GET_LOCK 互斥
- 保留：按份数轮转（BACKUP_KEEP_DB=14 / BACKUP_KEEP_STORAGE=7，手动与定时同池）
- 恢复：安全前置（恢复前先对目标库 dump 现场）→ 覆盖重建 → 导入（MRG_MYISAM 引擎代差容忍跳过）
- 元数据：`backup_runs` 表（服务自治建表；web 侧只读）

详见 docker/backup/compose.yaml 与 docs/ops/BACKUP.md。
