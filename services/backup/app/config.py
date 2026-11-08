"""备份服务配置（环境变量单一来源；全部必填项缺失时启动即报错，不带病运行）。"""
import os

def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"缺少必需环境变量：{name}")
    return value

DB_HOST = os.environ.get("BACKUP_DB_HOST", "funwind-mysql")
DB_PORT = int(os.environ.get("BACKUP_DB_PORT", "3306"))
DB_USER = os.environ.get("BACKUP_DB_USER", "root")
DB_PASSWORD = _required("BACKUP_DB_PASSWORD")
DB_NAME = os.environ.get("BACKUP_DB_NAME", "qingyisub")

# 元数据与 dump 共用同一连接凭据；OPS_TOKEN 保护全部管理类 API
OPS_TOKEN = _required("OPS_TOKEN")

# 备份源（应用存储卷，只读挂载）与备份输出（备份卷，读写挂载）
SOURCE_STORAGE_DIR = os.environ.get("BACKUP_SOURCE_DIR", "/source/storage")
TARGET_DIR = os.environ.get("BACKUP_TARGET_DIR", "/data/backups")

# 保留策略：按份数轮转（手动与定时同池，删最旧）
KEEP_DB = int(os.environ.get("BACKUP_KEEP_DB", "14"))
KEEP_STORAGE = int(os.environ.get("BACKUP_KEEP_STORAGE", "7"))

# 定时（cron 表达式，容器时区 Asia/Shanghai）
DB_CRON = os.environ.get("BACKUP_DB_CRON", "10 3 * * *")
STORAGE_CRON = os.environ.get("BACKUP_STORAGE_CRON", "40 3 * * *")

# 互斥锁名：备份与恢复互斥（MySQL GET_LOCK，服务重启自动释放）
LOCK_NAME = os.environ.get("BACKUP_LOCK_NAME", "funwind-backup")
