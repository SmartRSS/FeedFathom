FROM --platform=$BUILDPLATFORM oven/bun:slim AS dev
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/bun"]

FROM --platform=$BUILDPLATFORM oven/bun:slim AS base
WORKDIR /app

# Copy configuration files first
COPY svelte.config.js vite.config.ts tsconfig.json /app/
COPY drizzle /app/drizzle/

# Copy package files and install dependencies
COPY package.json bun.lock /app/

# Install dependencies with caching
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --omit=dev --frozen-lockfile

# Copy source files
COPY static /app/static
COPY src/ /app/src/

# Create build directory and build
RUN mkdir -p /app/build && \
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") && \
    bun build-image && \
    echo "Build timestamp: $timestamp" && \
    echo "$timestamp" > /app/build/BUILD_TIME

FROM --platform=$TARGETPLATFORM oven/bun:slim AS release
WORKDIR /app

# Copy only the necessary files from base
COPY --from=base /app/drizzle/ /app/drizzle/
COPY --from=base /app/build/ /app/
ENTRYPOINT ["/usr/local/bin/bun"]
