FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine AS runtime
LABEL maintainer="sre-team"
LABEL app="worker"

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY worker.js .

RUN apk add --no-cache tini
USER appuser

EXPOSE 9091
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "worker.js"]

HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:9091/healthz || exit 1
