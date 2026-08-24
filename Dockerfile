# ============================================================
#  Docker Manager - 生产环境镜像
#  多阶段构建：builder 编译 → runtime 运行
#  用法:
#    docker build -t docker-manager .
#    docker run -d -p 9528:9528 -v /var/lib/docker-manager:/data \
#      -v /var/run/docker.sock:/var/run/docker.sock docker-manager
# ============================================================

# ---- Stage 1: Builder ----
FROM node:22-slim AS builder

WORKDIR /build
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/

RUN npm ci --ignore-scripts
RUN cd server && npm ci --omit=dev
RUN cd web && npm ci

COPY . .
RUN cd web && npm run build
RUN cd server && npx tsc

# ---- Stage 2: Runtime ----
FROM node:22-slim

LABEL org.opencontainers.image.source="https://github.com/13861419/dockerDesktop"
LABEL org.opencontainers.image.description="Docker Manager - Container Management Panel"
LABEL org.opencontainers.image.licenses="MIT"

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 创建运行用户
RUN groupadd -r docker && \
    useradd -r -s /sbin/nologin -g docker -d /opt/docker-manager dockerman

WORKDIR /opt/docker-manager

# 复制后端编译产物
COPY --from=builder /build/server/dist ./server/dist
COPY --from=builder /build/server/package.json ./server/
COPY --from=builder /build/server/node_modules ./server/node_modules

# 复制前端静态资源
COPY --from=builder /build/web/dist ./static

# 数据目录
RUN mkdir -p /data && chown -R dockerman:docker /data /opt/docker-manager

# 默认配置
ENV PORT=9528
ENV HOST=0.0.0.0
ENV WEB_DIR=/opt/docker-manager/static
ENV DATA_DIR=/data

EXPOSE 9528

USER dockerman

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:9528/api/health-check || exit 1

CMD ["node", "server/dist/index.js"]
