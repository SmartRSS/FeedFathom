FROM oven/bun:slim AS dev
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/bun"]


FROM oven/bun:slim AS base
WORKDIR /app
COPY *.js *.json *.ts bun.lock drizzle /app/
RUN bun install --omit=dev --frozen-lockfile
COPY static /app/static
COPY src/ /app/src/
RUN timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") && \
    bun build-image && \
    echo "Build timestamp: $timestamp" && \
    echo "$timestamp" > /app/build/BUILD_TIME

FROM oven/bun:slim AS release
WORKDIR /app
COPY drizzle/ /app/drizzle/
COPY --from=base /app/build/ /app/

ENTRYPOINT ["/usr/local/bin/bun"]
