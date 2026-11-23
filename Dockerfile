FROM oven/bun:1.4.4-alpine AS dev
WORKDIR /app
COPY package.json bun.lock /app/
COPY vendor/ /app/vendor/
RUN bun install --frozen-lockfile
COPY tsconfig.json /app/
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/bun"]

FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-slim AS installer
WORKDIR /app
COPY package.json bun.lock /app/
COPY vendor/ /app/vendor/
RUN bun install --frozen-lockfile

FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-slim AS builder-base
WORKDIR /app
COPY tsconfig.json package.json /app/
COPY src/ /app/src/
COPY bin/ /app/bin/
COPY drizzle/meta/_journal.json /app/drizzle/meta/_journal.json
COPY --from=installer /app/node_modules /app/node_modules

FROM builder-base AS builder-server
RUN bun run build-server

FROM builder-base AS builder-worker
RUN bun run build-worker

FROM builder-base AS builder-migrator
COPY drizzle /app/drizzle/
RUN bun run build-migrator

FROM oven/bun:1.4.4-distroless AS release
WORKDIR /app
ENV NODE_ENV=production
USER 65532:65532
COPY --chown=65532:65532 package.json /app/
ARG FEEDFATHOM_BUILD=""
ENV FEEDFATHOM_BUILD=$FEEDFATHOM_BUILD
ENTRYPOINT ["/usr/local/bin/bun", "--no-addons"]

FROM release AS feedfathom-server
COPY --chown=65532:65532 --from=builder-server /app/build/ /app/
CMD ["index.js"]

FROM release AS feedfathom-worker
COPY --chown=65532:65532 --from=builder-worker /app/build/ /app/
CMD ["worker.js"]

FROM release AS feedfathom-migrator
COPY --chown=65532:65532 --from=builder-migrator /app/build/ /app/
COPY --chown=65532:65532 --from=builder-migrator /app/drizzle/ /app/drizzle/
CMD ["migrator.js"]
