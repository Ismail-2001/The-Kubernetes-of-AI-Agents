# Stage 1: Build
FROM node:26-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY observability-plane/package.json ./observability-plane/

RUN npm ci
RUN npm run build -w packages/shared

COPY observability-plane/tsconfig.json ./observability-plane/
COPY observability-plane/src/ ./observability-plane/src/

RUN npm run build -w observability-plane

# Stage 2: Production
FROM node:26-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 egaop && adduser --system --uid 1001 egaop
COPY --from=builder /app/observability-plane/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/observability-plane/package.json ./
RUN rm -rf node_modules/@e-gaop/shared
COPY --from=builder /app/packages/shared ./node_modules/@e-gaop/shared
RUN cp -r node_modules/@e-gaop/shared/node_modules/* node_modules/ 2>/dev/null; rm -rf node_modules/@e-gaop/shared/node_modules
USER egaop
EXPOSE 50056 15056
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:15056/healthz', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"
CMD ["node", "dist/index.js"]
