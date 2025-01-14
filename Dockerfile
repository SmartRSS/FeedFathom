FROM oven/bun:alpine AS base
WORKDIR /app
COPY bunfile-docker.toml bunfile.toml
COPY *.js *.json *.ts bun.lock drizzle /app/
RUN bun install
COPY src/ /app/src/
RUN timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") && \
    echo "Build timestamp: $timestamp" && \
    echo "$timestamp" > /app/BUILD_TIME

FROM base AS build
RUN export NODE_ENV=production && bun run build-server && bun run build-worker

FROM oven/bun:alpine AS release
RUN apk add curl --no-cache
WORKDIR /app
COPY drizzle/ /app/drizzle/
COPY --from=build /app/build/ /app/build/
COPY --from=base /app/BUILD_TIME /app/BUILD_TIME

ENTRYPOINT ["/usr/local/bin/bun"]
