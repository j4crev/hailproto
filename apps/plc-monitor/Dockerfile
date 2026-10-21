FROM oven/bun:1.4.0 AS codec-build
WORKDIR /workspace/hailproto
COPY hailproto/package.json hailproto/bun.lock hailproto/tsconfig.json ./
COPY hailproto/packages/hail-codec-ts ./packages/hail-codec-ts
RUN bun install --frozen-lockfile
RUN bun run --cwd packages/hail-codec-ts build

FROM node:24.18-alpine3.23 AS plc-lib-build
RUN npm install --global pnpm@11.11.0
WORKDIR /workspace/did-method-plc
COPY did-method-plc/package.json did-method-plc/pnpm-lock.yaml did-method-plc/pnpm-workspace.yaml ./
COPY did-method-plc/.npmrc did-method-plc/tsconfig.json ./
COPY did-method-plc/packages/lib ./packages/lib
RUN pnpm install --filter @did-plc/lib... --frozen-lockfile
RUN pnpm --filter @did-plc/lib exec tsc --build tsconfig.build.json --force

FROM oven/bun:1.4.0 AS dependencies
WORKDIR /workspace/hail-plc-monitor-ts
COPY hail-plc-monitor-ts/package.json hail-plc-monitor-ts/bun.lock ./
COPY --from=codec-build /workspace/hailproto/packages/hail-codec-ts /workspace/hailproto/packages/hail-codec-ts
COPY --from=plc-lib-build /workspace/did-method-plc/packages/lib /workspace/did-method-plc/packages/lib
RUN bun install --production --cwd /workspace/hailproto/packages/hail-codec-ts
RUN bun install --production --cwd /workspace/did-method-plc/packages/lib
RUN bun install --production --frozen-lockfile

FROM oven/bun:1.4.0
WORKDIR /workspace/hail-plc-monitor-ts
COPY --from=dependencies /workspace /workspace
COPY hail-plc-monitor-ts/src ./src
COPY hail-plc-monitor-ts/migrations ./migrations
RUN mkdir /data && chown bun:bun /data
USER bun
CMD ["bun", "src/cli/run.ts"]
