# syntax=docker/dockerfile:1
FROM node:24-alpine

ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    DATA_DIR=/data \
    PORT=8787

# The app runs on `node` alone. Remove the bundled package managers: they're unused at runtime and
# are the main source of image CVEs.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

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
