# Stage 1: Build
FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY admin-console/package.json ./admin-console/
RUN npm ci
COPY admin-console/ ./admin-console/
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_PATH=/app/node_modules
RUN node /app/node_modules/next/dist/bin/next build /app/admin-console

# Stage 2: Production
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
COPY --from=builder /app/admin-console/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/admin-console/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/admin-console/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
