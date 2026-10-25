# syntax=docker/dockerfile:1
FROM node:24-alpine

ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    DATA_DIR=/data \
    PORT=8787

WORKDIR /app
COPY package.json ./
COPY server/src ./server/src
COPY console ./console
COPY player ./player
COPY creatives ./creatives

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "server/src/server.ts"]
