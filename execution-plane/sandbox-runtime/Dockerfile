# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY execution-plane/sandbox-runtime/package.json ./execution-plane/sandbox-runtime/

RUN npm ci
RUN npm run build -w packages/shared

COPY execution-plane/sandbox-runtime/tsconfig.json ./execution-plane/sandbox-runtime/
COPY execution-plane/sandbox-runtime/src/ ./execution-plane/sandbox-runtime/src/

RUN npm run build -w execution-plane/sandbox-runtime

# Stage 2: Production
FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 egaop && adduser --system --uid 1001 egaop
COPY --from=builder /app/execution-plane/sandbox-runtime/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/execution-plane/sandbox-runtime/package.json ./
RUN rm -rf node_modules/@e-gaop/shared
COPY --from=builder /app/packages/shared ./node_modules/@e-gaop/shared
RUN cp -r node_modules/@e-gaop/shared/node_modules/* node_modules/ 2>/dev/null; rm -rf node_modules/@e-gaop/shared/node_modules
USER egaop
EXPOSE 50054 15054
CMD ["node", "dist/index.js"]
