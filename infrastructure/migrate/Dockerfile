FROM node:22-alpine
WORKDIR /app

# Install pg — the only runtime dependency for migrations
RUN npm install pg@^8.22.0

# Copy migration engine and SQL files
COPY scripts/migrate.mjs ./scripts/migrate.mjs
COPY migrations/ ./migrations/

ENTRYPOINT ["node", "scripts/migrate.mjs"]
CMD ["up"]
