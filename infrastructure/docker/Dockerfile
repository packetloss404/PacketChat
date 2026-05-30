FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json* tsconfig.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/files/package.json packages/files/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/providers/package.json packages/providers/package.json
RUN npm ci

FROM deps AS js-builder
COPY . .
RUN npm run build -w @packetchat/worker
RUN for name in auth config contracts db files jobs observability providers; do mkdir -p packages/$name/dist && cp -r apps/worker/dist/packages/$name/src/. packages/$name/dist/; done \
  && mkdir -p packages/db/dist/migrations \
  && cp packages/db/src/migrations/*.sql packages/db/dist/migrations/ \
  && sed -i 's/from "\.\/index"/from "\.\/index.js"/' packages/db/dist/migrate.js \
  && sed -i 's/from "\.\/provider-http"/from "\.\/provider-http.js"/' packages/providers/dist/index.js \
  && sed -i 's/from "\.\/job-router"/from "\.\/job-router.js"/' apps/worker/dist/apps/worker/src/index.js \
  && sed -i 's/from "\.\/queues"/from "\.\/queues.js"/' packages/jobs/dist/index.js \
  && sed -i 's/from "\.\/index"/from "\.\/index.js"/' packages/jobs/dist/queues.js
RUN node -e "const fs=require('fs'); const names=['auth','config','contracts','db','files','jobs','observability','providers']; for (const name of names) { const path='packages/'+name+'/package.json'; const pkg=JSON.parse(fs.readFileSync(path,'utf8')); pkg.exports={'.':'./dist/index.js'}; fs.writeFileSync(path, JSON.stringify(pkg, null, 2)+'\n'); }"

FROM js-builder AS web-builder
RUN npm run build -w @packetchat/web
RUN npm prune --omit=dev

FROM js-builder AS runtime-builder
RUN npm prune --omit=dev

FROM base AS web
ENV NODE_ENV=production
COPY --from=web-builder /app/package.json ./package.json
COPY --from=web-builder /app/node_modules ./node_modules
COPY --from=web-builder /app/apps ./apps
COPY --from=web-builder /app/packages ./packages
COPY --from=web-builder /app/scripts ./scripts
WORKDIR /app/apps/web
EXPOSE 3000
USER node
CMD ["npm", "run", "start"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=runtime-builder /app/package.json ./package.json
COPY --from=runtime-builder /app/node_modules ./node_modules
COPY --from=runtime-builder /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=runtime-builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=runtime-builder /app/packages ./packages
WORKDIR /app/apps/worker
USER node
CMD ["node", "dist/apps/worker/src/index.js"]

FROM base AS migrator
ENV NODE_ENV=production
COPY --from=runtime-builder /app/package.json ./package.json
COPY --from=runtime-builder /app/node_modules ./node_modules
COPY --from=runtime-builder /app/packages ./packages
WORKDIR /app
USER node
CMD ["node", "packages/db/dist/migrate.js"]
