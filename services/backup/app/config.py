"""运维任务管线配置（环境变量单一来源）。

M14 起必填项缺失**不在 import 期抛错**：import 期 raise 会让 uvicorn 直接退出，在
`restart: unless-stopped` 下形成崩溃循环（M14 F23）。改为收集缺失项、服务以降级模式启动——
/health 返回 503 如实报告缺失项，调度器不启动，管理类 API 一律 503。
"""
import os


def _env_int(name: str, default: int) -> int:
    """整型环境变量；缺失或非法时回落默认值（运维参数写错不该让服务起不来）。"""
    raw = os.environ.get(name, "")
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


DB_HOST = os.environ.get("BACKUP_DB_HOST", "funwind-mysql")
DB_PORT = _env_int("BACKUP_DB_PORT", 3306)
DB_USER = os.environ.get("BACKUP_DB_USER", "root")
DB_PASSWORD = os.environ.get("BACKUP_DB_PASSWORD", "")
DB_NAME = os.environ.get("BACKUP_DB_NAME", "qingyisub")

# 管理类 API 的鉴权口令（与 web 侧 OPS_API_TOKEN 同值；内部动作接口共用）
OPS_TOKEN = os.environ.get("OPS_TOKEN", "")

# SSR 内部动作接口（节日装扮写 campaigns 用，D8）：funwind-internal 网内的应用容器
SSR_BASE_URL = os.environ.get("OPS_SSR_BASE_URL", "http://funwind-app:3311")

# 备份源（应用存储卷，只读挂载）与备份输出（备份卷，读写挂载）
SOURCE_STORAGE_DIR = os.environ.get("BACKUP_SOURCE_DIR", "/source/storage")
TARGET_DIR = os.environ.get("BACKUP_TARGET_DIR", "/data/backups")

# 保留份数的环境默认值（优先级：任务参数 > site_settings 动态策略 > 这里）
KEEP_DB = _env_int("BACKUP_KEEP_DB", 14)
KEEP_STORAGE = _env_int("BACKUP_KEEP_STORAGE", 7)

# 内置默认任务的 cron（配置表未就绪时的回落；星期字段须用名称，见 triggers.validate_cron）
DB_CRON = os.environ.get("BACKUP_DB_CRON", "10 3 * * *")
STORAGE_CRON = os.environ.get("BACKUP_STORAGE_CRON", "40 3 * * *")

# 备份/恢复互斥锁名（MySQL GET_LOCK，连接断开自动释放）
LOCK_NAME = os.environ.get("BACKUP_LOCK_NAME", "funwind-backup")

# 调度与台账时间口径：北京墙面时间（与库内 DATETIME 一致）
TIMEZONE = "Asia/Shanghai"

# 运行时节律
RECONCILE_SECONDS = _env_int("OPS_RECONCILE_SECONDS", 300)  # 周期对账：配置热加载的兜底
BOOTSTRAP_RETRY_SECONDS = _env_int("OPS_BOOTSTRAP_RETRY_SECONDS", 30)  # 库不通时的引导重试间隔
STALE_RUN_MINUTES = _env_int("OPS_STALE_RUN_MINUTES", 120)  # running 超过该时长视为进程中断残留


def missing_required_env() -> list[str]:
    """缺失的必需配置项（读模块级取值，测试可直接改写属性）。"""
    missing = []
    if not DB_PASSWORD:
        missing.append("BACKUP_DB_PASSWORD")
    if not OPS_TOKEN:
        missing.append("OPS_TOKEN")
    return missing
