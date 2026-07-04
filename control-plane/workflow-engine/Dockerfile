# Stage 1: Build
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY control-plane/workflow-engine/package.json ./control-plane/workflow-engine/

RUN npm ci
RUN for dir in workflow-engine; do [ -d "node_modules/$dir/node_modules" ] && cp -r "node_modules/$dir/node_modules/"* node_modules/ 2>/dev/null || true; done
RUN npm run build -w packages/shared

COPY control-plane/workflow-engine/tsconfig.json ./control-plane/workflow-engine/
COPY control-plane/workflow-engine/src/ ./control-plane/workflow-engine/src/

RUN npm run build -w control-plane/workflow-engine

# Stage 2: Production
FROM node:22-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 egaop && useradd --uid 1001 --gid 1001 --shell /bin/false egaop
COPY --from=builder /app/control-plane/workflow-engine/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/control-plane/workflow-engine/package.json ./
RUN rm -rf node_modules/@e-gaop/shared
COPY --from=builder /app/packages/shared ./node_modules/@e-gaop/shared
RUN cp -r node_modules/@e-gaop/shared/node_modules/* node_modules/ 2>/dev/null; rm -rf node_modules/@e-gaop/shared/node_modules
USER egaop
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:15058/healthz', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"
CMD ["node", "dist/index.js"]
