FROM oven/bun:slim AS dev
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/bun"]


FROM oven/bun:slim AS base
WORKDIR /app
COPY *.js *.json *.ts bun.lock drizzle /app/
RUN bun install --omit=dev --frozen-lockfile
COPY static /app/static
COPY src/ /app/src/
RUN bun --bun run build-server && bun --bun run build-worker && \
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") && \
    echo "Build timestamp: $timestamp" && \
    echo "$timestamp" > /app/build/BUILD_TIME

FROM oven/bun:slim AS release
WORKDIR /app
COPY drizzle/ /app/drizzle/
COPY --from=base /app/build/ /app/

ENTRYPOINT ["/usr/local/bin/bun"]
