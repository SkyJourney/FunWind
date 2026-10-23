# FunWind dev · 应用开发容器（可选路径：本地 pnpm dev 等价）
FROM node:24-alpine
WORKDIR /repo
RUN corepack enable
# 依赖挂载前先装（利用层缓存）
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY migration/package.json migration/
RUN pnpm install --frozen-lockfile
COPY . .
EXPOSE 3100
CMD ["pnpm", "--filter", "@funwind/web", "dev"]
