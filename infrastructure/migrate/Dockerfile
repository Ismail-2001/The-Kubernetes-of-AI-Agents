FROM node:22-alpine
WORKDIR /app

RUN npm install pg@^8.22.0

COPY scripts/migrate.mjs ./scripts/migrate.mjs
COPY migrations/ ./migrations/

RUN addgroup -S migrate && adduser -S migrate -G migrate
RUN chown -R migrate:migrate /app
# npm/npx were build-time tools; this image only runs prebuilt JS. Dropping npm's
# bundled transitive deps removes fixable CVEs that fail the Trivy image gate.
RUN rm -rf /usr/local/lib/node_modules/npm && rm -f /usr/local/bin/npm /usr/local/bin/npx
USER migrate

ENTRYPOINT ["node", "scripts/migrate.mjs"]
CMD ["up"]
