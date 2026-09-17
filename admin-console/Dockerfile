# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app/admin-console
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build

# Stage 2: Production
FROM node:22-alpine AS runner
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
