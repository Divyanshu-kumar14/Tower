# TOWER frontend image (T-11a) — Next.js standalone runner.
#
# Base: node:20-alpine (minor pin, no :latest). Official node images are
# multi-arch (linux/amd64 + linux/arm64), so this is ARM64-safe on the
# beast. Devops pins the digest in cloudbuild at deploy.
FROM node:20-alpine AS deps

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY frontend ./
ENV NEXT_TELEMETRY_DISABLED=1
# Requires next.config.mjs `output: "standalone"` (T-11a).
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Standalone server + static assets. (No public/ COPY: the repo ships no
# frontend/public dir; re-add this line if one appears.)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Non-root runtime: the official node image ships the `node` user.
USER node

EXPOSE 3000

# Liveness via node fetch (no curl/wget in the runner): any HTTP status
# counts as alive, because /api/health returns 503 LOT_OPS_DEGRADED while
# serving reads-only — degraded is still alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://localhost:3000/api/health').then(()=>process.exit(0)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
