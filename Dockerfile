FROM oven/bun:1.2.9-slim AS dev
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/bun"]

FROM --platform=$BUILDPLATFORM oven/bun:1.2.9-slim AS builder
WORKDIR /app

COPY svelte.config.js vite.config.ts tsconfig.json /app/
COPY drizzle /app/drizzle/

COPY package.json bun.lock /app/

# due to the way dependencies are resolved I marked quality tools as dev and build tools as base
# I don't want to install quality tools during the build process so that's why I'm omitting them this way
# node_modules aren't copied to the resulting image because the build bundles required libraries
RUN bun install --omit=dev --frozen-lockfile

# Copy source files
COPY static /app/static
COPY src/ /app/src/

# Create build directory and build
# store timestamp for versioning purposes
# it is attached to UAS of performed requests for easier debugging
RUN mkdir -p /app/build && \
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") && \
    bun build-for-image && \
    echo "Build timestamp: $timestamp" && \
    echo "$timestamp" > /app/build/BUILD_TIME

FROM oven/bun:1.2.9-slim AS release
WORKDIR /app

# drizzle files are needed for migrations
COPY --from=builder /app/drizzle/ /app/drizzle/
# Copy only the built files and runtime dependencies from builder
COPY --from=builder /app/build/ /app/
# node_modules are not needed, required libraries are bundled during build
ENTRYPOINT ["/usr/local/bin/bun"]
