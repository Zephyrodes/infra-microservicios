# ── Etapa de build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# ── Etapa de ejecución ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
LABEL maintainer="sre-team"
LABEL app="api-service"

# Usuario sin privilegios para seguridad
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY app.js .

# Tini para manejo correcto de señales
RUN apk add --no-cache tini

USER appuser

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "app.js"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1
