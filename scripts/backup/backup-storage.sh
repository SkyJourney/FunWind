#!/usr/bin/env sh
# FunWind · STORAGE_DIR 增量镜像脚本（M13 Step 3）
# ============================================================
# 语义：把应用存储目录（hex 桶附件/头像 + site/ 品牌位 + install.lock）rsync 到备份目录，
# 排除可再生内容（.cache 缩略图缓存 / .tmp 临时文件——BACKUP.md F6 口径）。
# 用法：
#   STORAGE_DIR=/data/funwind/storage BACKUP_DIR=/opt/funwind/backups \
#     scripts/backup/backup-storage.sh
# 环境变量：
#   STORAGE_DIR 应用存储目录（必填；生产容器内是 /data/storage，宿主机路径按 compose 卷实际位置）
#   BACKUP_DIR  备份根目录（默认 /opt/funwind/backups；镜像落在 $BACKUP_DIR/storage/）
#   WITH_DELETE 加 --delete 保持严格镜像（默认开启；设为 0 关闭——保守保留源端已删文件）
# 安全护栏：DEST 必须位于 BACKUP_DIR 之下且与 SRC 不同目录（防参数颠倒清空源目录——
# 参照 packages/db e2e-safety 的目标断言纪律）。
set -eu

SRC="${STORAGE_DIR:?请设置 STORAGE_DIR（应用存储目录）}"
BACKUP_DIR="${BACKUP_DIR:-/opt/funwind/backups}"
WITH_DELETE="${WITH_DELETE:-1}"

command -v rsync >/dev/null || { echo "需要 rsync"; exit 1; }
[ -d "$SRC" ] || { echo "源目录不存在：$SRC"; exit 1; }

DEST="$BACKUP_DIR/storage"
case "$DEST" in
  "$BACKUP_DIR"/storage) ;; # 通过
  *) echo "护栏失败：DEST($DEST) 必须是 \$BACKUP_DIR/storage"; exit 1 ;;
esac
# 先建 DEST（首次运行不存在；后面的子目录护栏需要 cd 成功才能取真实路径）
mkdir -p "$DEST"
[ "$SRC" != "$DEST" ] || { echo "护栏失败：SRC 与 DEST 相同"; exit 1; }
case "$(cd "$SRC" && pwd -P)/" in
  "$(cd "$DEST" && pwd -P)/"*) echo "护栏失败：SRC 是 DEST 的子目录"; exit 1 ;;
esac
case "$(cd "$DEST" && pwd -P)/" in
  "$(cd "$SRC" && pwd -P)/"*) echo "护栏失败：DEST 是 SRC 的子目录"; exit 1 ;;
esac

# -a 保属性；排除可再生缓存；--delete 严格镜像（可选）；--stats 输出变更行数
ARGS="-a --stats --exclude=.cache/ --exclude=.tmp/"
[ "$WITH_DELETE" = "1" ] && ARGS="$ARGS --delete"
# shellcheck disable=SC2086
rsync $ARGS "$SRC/" "$DEST/"

FILES="$(find "$DEST" -type f -not -path "*/.cache/*" -not -path "*/.tmp/*" | wc -l | tr -d ' ')"
echo "✔ 存储镜像完成：${DEST}（${FILES} 个文件，排除 .cache/.tmp）"
