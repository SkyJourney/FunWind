# FunWind 生产镜像（M13 Step 1 / F2）：多阶段构建，产物形态 = 整仓 + node_modules（不做 standalone）。
# 构建（仓库根执行）：docker build -f docker/production/Dockerfile -t funwind-web:latest .
# 运行：docker/production/compose.yaml（Step 2）——.env / STORAGE_DIR 全部外置注入，镜像内无密钥。
FROM node:24-alpine AS builder
WORKDIR /repo
RUN corepack enable
# 依赖清单先COPY（利用层缓存）：新增依赖才失效重装
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/content/package.json packages/content/
COPY migration/package.json migration/
RUN pnpm install --frozen-lockfile
COPY . .
# 构建期不需要真实密钥（页面全部动态渲染，无 build 期 db/存储访问）；但 headers() 在 build 期求值
# 固化 HSTS 判定（security-headers.ts:68），须以生产域名的 https 形态构建——域名是公开常量，
# 特殊部署可用 --build-arg APP_URL=https://<你的域名> 覆盖。
ARG APP_URL=https://qingyisub.top
ENV APP_URL=${APP_URL} STORAGE_DIR=/tmp/build-storage NEXT_TELEMETRY_DISABLED=1
# .next/cache 是构建期缓存（webpack/image），next start 不读它——不进产物
RUN pnpm db:build && pnpm --filter @funwind/web build && rm -rf apps/web/.next/cache

FROM node:24-alpine AS runner
WORKDIR /repo
# corepack 需在 build 期把 pnpm 下载到位（与根 package.json 的 packageManager 保持同步），运行时离线可用
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate \
  && addgroup -S funwind && adduser -S funwind -G funwind
COPY --from=builder --chown=funwind:funwind /repo ./
USER funwind
EXPOSE 3311
# D7 拓扑：宝塔 nginx 反代 127.0.0.1:3311；容器端口固定 3311，宿主映射由 compose 决定
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:3311/api/health" || exit 1
CMD ["pnpm", "--filter", "@funwind/web", "exec", "next", "start", "--port", "3311", "--hostname", "0.0.0.0"]
