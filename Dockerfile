# dev image is used for development purposes
FROM oven/bun:1.2.21-alpine AS dev
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/bun"]

# --- Installer (shared dependencies) ---
FROM --platform=$BUILDPLATFORM oven/bun:1.2.21-alpine AS installer
WORKDIR /app
COPY package.json bun.lock svelte.config.js vite.config.ts tsconfig.json /app/
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --omit=peer --frozen-lockfile

# --- Server Builder ---
FROM --platform=$BUILDPLATFORM oven/bun:1.2.21-alpine AS builder-server
WORKDIR /app
COPY svelte.config.js vite.config.ts tsconfig.json package.json /app/
COPY static /app/static
COPY src/ /app/src/
COPY --from=installer /app/node_modules /app/node_modules
RUN mkdir -p /app/build && \
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") && \
    bun run build-server && \
    echo "Build timestamp: $timestamp" && \
    echo "$timestamp" > /app/build/BUILD_TIME

# --- Worker Builder ---
FROM --platform=$BUILDPLATFORM oven/bun:1.2.21-alpine AS builder-worker
WORKDIR /app
COPY svelte.config.js vite.config.ts tsconfig.json package.json /app/
COPY drizzle /app/drizzle/
COPY static /app/static
COPY src/ /app/src/
COPY --from=installer /app/node_modules /app/node_modules
RUN mkdir -p /app/build && \
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") && \
    bun svelte-kit sync && \
    bun run build-worker && \
    echo "Build timestamp: $timestamp" && \
    echo "$timestamp" > /app/build/BUILD_TIME

# --- Server Release ---
FROM oven/bun:1.2.21-alpine AS feedfathom-server
WORKDIR /app
RUN apk add --no-cache curl
USER 1000:1000
COPY package.json /app/
COPY --from=builder-server /app/build/ /app/
ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["index.js"]
# --- Worker Release ---
FROM oven/bun:1.2.21-alpine AS feedfathom-worker
WORKDIR /app
RUN apk add --no-cache curl
USER 1000:1000
COPY package.json /app/
COPY --from=builder-worker /app/build/ /app/
COPY --from=builder-worker /app/drizzle/ /app/drizzle/
ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["worker-entrypoint.js"]
