# Multi-arch (amd64 / arm64 → Raspberry Pi 4/5). No build step, no runtime dependencies.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    DATA_DIR=/data \
    PORT=8787

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
CMD ["node", "src/server.ts"]
