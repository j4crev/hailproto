FROM node:24.18-alpine3.23 AS plc-lib-build
RUN npm install --global pnpm@11.11.0
WORKDIR /workspace/hail/vendor/did-method-plc
COPY vendor/did-method-plc/package.json vendor/did-method-plc/pnpm-lock.yaml vendor/did-method-plc/pnpm-workspace.yaml ./
COPY vendor/did-method-plc/.npmrc vendor/did-method-plc/tsconfig.json ./
COPY vendor/did-method-plc/packages/lib ./packages/lib
RUN pnpm install --filter @did-plc/lib... --frozen-lockfile
RUN pnpm --filter @did-plc/lib exec tsc --build tsconfig.build.json --force

FROM oven/bun:1.4.0 AS build
WORKDIR /workspace/hail
COPY package.json bun.lock tsconfig.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/plc-monitor/package.json ./apps/plc-monitor/package.json
COPY packages/hail-codec-ts ./packages/hail-codec-ts
COPY packages/hail-client-support ./packages/hail-client-support
COPY --from=plc-lib-build /workspace/hail/vendor/did-method-plc ./vendor/did-method-plc
RUN bun install --frozen-lockfile
RUN bun run --cwd packages/hail-codec-ts build

FROM oven/bun:1.4.0 AS dependencies
WORKDIR /workspace/hail
COPY package.json bun.lock tsconfig.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/plc-monitor/package.json ./apps/plc-monitor/package.json
COPY --from=build /workspace/hail/packages/hail-codec-ts ./packages/hail-codec-ts
COPY --from=build /workspace/hail/packages/hail-client-support ./packages/hail-client-support
COPY --from=build /workspace/hail/vendor/did-method-plc ./vendor/did-method-plc
RUN bun install --production --frozen-lockfile

FROM oven/bun:1.4.0
WORKDIR /workspace/hail/apps/plc-monitor
COPY --from=dependencies /workspace/hail /workspace/hail
COPY apps/plc-monitor/src ./src
COPY apps/plc-monitor/migrations ./migrations
RUN mkdir /data && chown bun:bun /data
USER bun
CMD ["bun", "src/cli/run.ts"]
