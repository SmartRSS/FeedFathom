# dev image is used for development purposes
FROM dhi.io/bun:1.4.0-alpine3.22-dev AS dev
WORKDIR /app
COPY package.json bun.lock /app/
COPY patches/ /app/patches/
COPY vendor/ /app/vendor/
RUN bun install --frozen-lockfile
COPY tsconfig.json /app/
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/bun"]

# --- Installer (shared dependencies) ---
FROM --platform=$BUILDPLATFORM dhi.io/bun:1.4.0-alpine3.22-dev AS installer
WORKDIR /app
COPY package.json bun.lock /app/
COPY patches/ /app/patches/
COPY vendor/ /app/vendor/
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

# --- Builder Base ---
FROM --platform=$BUILDPLATFORM dhi.io/bun:1.4.0-alpine3.22-dev AS builder-base
WORKDIR /app
COPY tsconfig.json package.json /app/
COPY src/ /app/src/
COPY bin/ /app/bin/
COPY --from=installer /app/node_modules /app/node_modules

# --- Server Builder ---
FROM builder-base AS builder-server
RUN bun run build-server

# --- Worker Builder ---
FROM builder-base AS builder-worker
RUN bun run build-worker

# --- Migrator Builder ---
FROM builder-base AS builder-migrator
COPY drizzle /app/drizzle/
RUN bun run build-migrator

# --- Release Base ---
FROM dhi.io/bun:1.4.0-alpine3.22 AS release
WORKDIR /app
ENV NODE_ENV=production
USER 65532:65532
COPY --chown=65532:65532 package.json /app/
ENTRYPOINT ["/usr/local/bin/bun"]

# --- Server Release ---
FROM release AS feedfathom-server
COPY --chown=65532:65532 --from=builder-server /app/build/ /app/
CMD ["index.js"]

# --- Worker Release ---
FROM release AS feedfathom-worker
COPY --chown=65532:65532 --from=builder-worker /app/build/ /app/
CMD ["worker.js"]

# --- Migrator Release ---
FROM release AS feedfathom-migrator
COPY --chown=65532:65532 --from=builder-migrator /app/build/ /app/
COPY --chown=65532:65532 --from=builder-migrator /app/drizzle/ /app/drizzle/
CMD ["migrator.js"]
