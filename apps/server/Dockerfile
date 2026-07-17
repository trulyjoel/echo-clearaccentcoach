FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/types/package.json packages/types/package.json
COPY apps/server/package.json apps/server/package.json
RUN pnpm install --frozen-lockfile --filter @callie/server...

FROM deps AS build
COPY packages/types packages/types
COPY apps/server apps/server
RUN pnpm --filter @callie/server build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/packages/types ./packages/types
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
