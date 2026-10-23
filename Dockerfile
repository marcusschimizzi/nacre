# One image for both Railway services: `api` (default CMD) and `worker` (start command override).
FROM node:24-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim AS runtime
ENV NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Plain SQL migrations for Railway's pre-deploy step (`npm run db:migrate`; dbmate is a prod dependency).
COPY migrations ./migrations
USER node
# Railway injects PORT; 3000 is the local default.
EXPOSE 3000
CMD ["node", "dist/api/main.js"]
