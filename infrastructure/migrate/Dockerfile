FROM node:22-alpine
WORKDIR /app

RUN npm install pg@^8.22.0

COPY scripts/migrate.mjs ./scripts/migrate.mjs
COPY migrations/ ./migrations/

RUN addgroup -S migrate && adduser -S migrate -G migrate
RUN chown -R migrate:migrate /app
USER migrate

ENTRYPOINT ["node", "scripts/migrate.mjs"]
CMD ["up"]
