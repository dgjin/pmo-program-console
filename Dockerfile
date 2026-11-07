# 零依赖：不需要 npm install，只要 Node 22.5+
FROM node:22-alpine

WORKDIR /app

COPY server.js ./
COPY public ./public

ENV PMO_HOST=0.0.0.0 \
    PMO_PORT=5177 \
    PMO_DB=/data/pmo.db

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 5177

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:5177/api/ready >/dev/null || exit 1

CMD ["node", "server.js"]
