# Stage 1: Build
FROM node:26-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY execution-plane/llm-router/package.json ./execution-plane/llm-router/

RUN npm ci
RUN npm run build -w packages/shared

COPY execution-plane/llm-router/tsconfig.json ./execution-plane/llm-router/
COPY execution-plane/llm-router/src/ ./execution-plane/llm-router/src/

RUN npm run build -w execution-plane/llm-router

# Stage 2: Production
FROM node:26-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 egaop && adduser --system --uid 1001 egaop
COPY --from=builder /app/execution-plane/llm-router/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/execution-plane/llm-router/package.json ./
RUN rm -rf node_modules/@e-gaop/shared
COPY --from=builder /app/packages/shared ./node_modules/@e-gaop/shared
RUN cp -r node_modules/@e-gaop/shared/node_modules/* node_modules/ 2>/dev/null; rm -rf node_modules/@e-gaop/shared/node_modules
USER egaop
EXPOSE 50053 15053
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:15053/healthz', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"
CMD ["node", "dist/index.js"]
