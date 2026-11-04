FROM node:24.18-alpine3.23 AS plc-lib-build
RUN npm install --global pnpm@11.11.0
WORKDIR /workspace/hail/vendor/did-method-plc
COPY vendor/did-method-plc/package.json vendor/did-method-plc/pnpm-lock.yaml vendor/did-method-plc/pnpm-workspace.yaml ./
COPY vendor/did-method-plc/.npmrc vendor/did-method-plc/tsconfig.json ./
COPY vendor/did-method-plc/packages/lib ./packages/lib
RUN pnpm install --filter @did-plc/lib... --frozen-lockfile
RUN pnpm --filter @did-plc/lib exec tsc --build tsconfig.build.json --force

# Build on an isolated CI builder; runtime remains Bun.
FROM node:24.18-bookworm-slim AS build
COPY --from=oven/bun:1.4.0 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace/hail
COPY package.json bun.lock tsconfig.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/content-builder/package.json ./apps/content-builder/package.json
COPY apps/plc-monitor/package.json ./apps/plc-monitor/package.json
COPY apps/client/package.json ./apps/client/package.json
COPY packages/hail-codec-ts ./packages/hail-codec-ts
COPY packages/hail-client-support ./packages/hail-client-support
COPY packages/hail-content-builder ./packages/hail-content-builder
COPY --from=plc-lib-build /workspace/hail/vendor/did-method-plc ./vendor/did-method-plc
RUN bun install --frozen-lockfile --filter hailproto --filter hail-client --filter @racrproto/codec --filter @racrproto/client-support --filter @racrproto/content-builder
RUN bun run --cwd packages/hail-codec-ts build
COPY apps/client ./apps/client
# This limits V8 old space only. CI also caps the entire BuildKit container.
RUN NODE_OPTIONS=--max-old-space-size=1024 bun run --cwd apps/client build

FROM oven/bun:1.4.0 AS dependencies
WORKDIR /workspace/hail
COPY package.json bun.lock tsconfig.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/content-builder/package.json ./apps/content-builder/package.json
COPY apps/plc-monitor/package.json ./apps/plc-monitor/package.json
COPY apps/client/package.json ./apps/client/package.json
COPY --from=build /workspace/hail/packages/hail-codec-ts ./packages/hail-codec-ts
COPY --from=build /workspace/hail/packages/hail-client-support ./packages/hail-client-support
COPY --from=build /workspace/hail/packages/hail-content-builder ./packages/hail-content-builder
COPY --from=build /workspace/hail/vendor/did-method-plc ./vendor/did-method-plc
RUN bun install --production --frozen-lockfile --filter hail-client --filter @racrproto/codec --filter @racrproto/client-support --filter @racrproto/content-builder

FROM oven/bun:1.4.0
WORKDIR /workspace/hail/apps/client
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 BODY_SIZE_LIMIT=28M
COPY --from=dependencies /workspace/hail/node_modules /workspace/hail/node_modules
COPY --from=dependencies /workspace/hail/packages /workspace/hail/packages
COPY --from=dependencies /workspace/hail/vendor /workspace/hail/vendor
COPY --from=dependencies /workspace/hail/apps/client/node_modules ./node_modules
COPY --from=build /workspace/hail/apps/client/build ./build
COPY apps/client/package.json ./package.json
USER bun
EXPOSE 3000
CMD ["bun", "build/index.js"]
