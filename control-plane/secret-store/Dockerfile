# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Stage 2: Production
FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 egaop && adduser --system --uid 1001 egaop
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
USER egaop
EXPOSE 50057 15057
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:15057/healthz', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"
CMD ["node", "dist/index.js"]
