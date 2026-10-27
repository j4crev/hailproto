FROM node:24.18-alpine3.23 AS plc-lib-build
RUN npm install --global pnpm@11.11.0
WORKDIR /workspace/hailproto/vendor/did-method-plc
COPY vendor/did-method-plc/package.json vendor/did-method-plc/pnpm-lock.yaml vendor/did-method-plc/pnpm-workspace.yaml ./
COPY vendor/did-method-plc/.npmrc vendor/did-method-plc/tsconfig.json ./
COPY vendor/did-method-plc/packages/lib ./packages/lib
RUN pnpm install --filter @did-plc/lib... --frozen-lockfile
RUN pnpm --filter @did-plc/lib exec tsc --build tsconfig.build.json --force

# Vite/adapter packaging stays within small-builder memory under Node; runtime remains Bun.
FROM node:24.18-bookworm-slim AS build
COPY --from=oven/bun:1.4.0 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace/hailproto
COPY package.json bun.lock tsconfig.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/plc-monitor/package.json ./apps/plc-monitor/package.json
COPY apps/client/package.json ./apps/client/package.json
COPY packages/hail-codec-ts ./packages/hail-codec-ts
COPY --from=plc-lib-build /workspace/hailproto/vendor/did-method-plc ./vendor/did-method-plc
RUN bun install --frozen-lockfile
RUN bun run --cwd packages/hail-codec-ts build
COPY apps/client ./apps/client
COPY apps/cli/src ./apps/cli/src
RUN bun run --cwd apps/client build

FROM oven/bun:1.4.0 AS dependencies
WORKDIR /workspace/hailproto
COPY package.json bun.lock tsconfig.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/plc-monitor/package.json ./apps/plc-monitor/package.json
COPY apps/client/package.json ./apps/client/package.json
COPY --from=build /workspace/hailproto/packages/hail-codec-ts ./packages/hail-codec-ts
COPY --from=build /workspace/hailproto/vendor/did-method-plc ./vendor/did-method-plc
RUN bun install --production --frozen-lockfile

FROM oven/bun:1.4.0
WORKDIR /workspace/hailproto/apps/server
ENV NODE_ENV=production
COPY --from=dependencies /workspace/hailproto/node_modules /workspace/hailproto/node_modules
COPY --from=dependencies /workspace/hailproto/packages/hail-codec-ts /workspace/hailproto/packages/hail-codec-ts
COPY --from=dependencies /workspace/hailproto/apps/server/package.json ./package.json
COPY --from=dependencies /workspace/hailproto/apps/server/node_modules ./node_modules
COPY --from=dependencies /workspace/hailproto/apps/client/node_modules /workspace/hailproto/apps/client/node_modules
COPY --from=build /workspace/hailproto/apps/client/build /workspace/hailproto/apps/client/build
COPY apps/server/src ./src
COPY apps/server/migrations ./migrations
RUN test -f src/cli/authorize-provider-role.ts && test -f src/cli/provider-operator.ts
USER bun
EXPOSE 3000
CMD ["bun", "src/index.ts"]
