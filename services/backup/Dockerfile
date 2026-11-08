# FunWind 备份服务（Python + FastAPI + APScheduler）：职责分离的备份/恢复执行体。
# 客户端工具从官方 mysql:8.4 镜像拷贝（glibc 兼容）：mysqldump 与服务端同源，认证/语法零兼容问题
# （alpine 的 mariadb-client 不带 caching_sha2_password 插件，无法认证 MySQL 8.4 ——实测教训）。
FROM mysql:8.4 AS mysql-client

FROM python:3.12-slim
COPY --from=mysql-client /usr/bin/mysqldump /usr/local/bin/mysqldump
COPY --from=mysql-client /usr/bin/mysql /usr/local/bin/mysql
RUN apt-get update && apt-get install -y --no-install-recommends tzdata libncurses6 && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY cli.py .
ENV TZ=Asia/Shanghai PYTHONUNBUFFERED=1
EXPOSE 8000
# APScheduler 在 uvicorn 的 lifespan 里启动（单进程内并发，服务体量无需多 worker）
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
