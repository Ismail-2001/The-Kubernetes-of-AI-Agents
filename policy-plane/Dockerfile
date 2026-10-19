# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY policy-plane/package.json ./policy-plane/

RUN npm config set registry https://registry.npmmirror.com
RUN npm ci
RUN for dir in policy-plane; do [ -d "node_modules/$dir/node_modules" ] && cp -r "node_modules/$dir/node_modules/"* node_modules/ 2>/dev/null || true; done
RUN npm run build -w packages/shared

COPY policy-plane/tsconfig.json ./policy-plane/
COPY policy-plane/src/ ./policy-plane/src/

RUN npm run build -w policy-plane

# Stage 2: Production
FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 egaop && adduser --system --uid 1001 egaop
COPY --from=builder /app/policy-plane/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/policy-plane/package.json ./
RUN rm -rf node_modules/@e-gaop/shared
COPY --from=builder /app/packages/shared ./node_modules/@e-gaop/shared
RUN cp -r node_modules/@e-gaop/shared/node_modules/* node_modules/ 2>/dev/null; rm -rf node_modules/@e-gaop/shared/node_modules
USER egaop
EXPOSE 50059 15059
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:15059/healthz', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"
CMD ["node", "dist/index.js"]
