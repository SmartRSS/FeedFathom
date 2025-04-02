#!/bin/bash

set -euo pipefail

VERSION=v0.1.0

# Print metadata for Docker CLI plugin
if [ "$1" = "docker-cli-plugin-metadata" ]; then
  cat <<EOF
{
  "SchemaVersion": "0.1.0",
  "Vendor": "FeedFathom",
  "Version": "$VERSION",
  "ShortDescription": "Gradually roll out updates to specified services"
}
EOF
  exit
fi

# Save docker arguments, i.e. arguments before "rollout"
DOCKER_ARGS=""
while [ $# -gt 0 ]; do
  if [ "$1" = "rollout" ]; then
    shift
    break
  fi

  DOCKER_ARGS="$DOCKER_ARGS $1"
  shift
done

# Check if compose v2 is available
if docker compose >/dev/null 2>&1; then
  # shellcheck disable=SC2086 # DOCKER_ARGS must be unquoted to allow multiple arguments
  COMPOSE_COMMAND="docker $DOCKER_ARGS compose"
elif docker-compose >/dev/null 2>&1; then
  COMPOSE_COMMAND="docker-compose"
else
  echo "docker compose or docker-compose is required"
  exit 1
fi

# Function to get target replicas from compose config
get_target_replicas() {
  local SERVICE="$1"
  shift  # Remove service name from args
  local COMPOSE_FILES=("$@")

  # Get the full config with all compose files
  echo "Executing: $COMPOSE_COMMAND ${COMPOSE_FILES[*]} config"
  local FULL_CONFIG
  FULL_CONFIG=$($COMPOSE_COMMAND "${COMPOSE_FILES[@]}" config)
  # Find the service section and get the first replicas value after it
  local TARGET_REPLICAS
  TARGET_REPLICAS=$(echo "$FULL_CONFIG" | sed -n "/^services:$/,/^[a-z]/p" | grep -A100 "^  $SERVICE:" | grep -o 'replicas: [0-9]*' | head -n1 | cut -d' ' -f2)

  # Default to 1 if no value found
  if [ -z "$TARGET_REPLICAS" ]; then
    TARGET_REPLICAS=1
  fi

  echo "$TARGET_REPLICAS"
}

# Function to calculate step size (10% of target replicas, rounded up)
calculate_step() {
  local TARGET="$1"
  local STEP
  STEP=$(( (TARGET + 9) / 10 ))  # Ceiling division by 10
  echo "$STEP"
}

# Function to get current number of replicas
get_current_replicas() {
  local SERVICE="$1"
  shift  # Remove service name from args
  local COMPOSE_FILES=("$@")
  local COUNT

  echo "Executing: $COMPOSE_COMMAND ${COMPOSE_FILES[*]} ps -q $SERVICE | wc -l"
  COUNT=$($COMPOSE_COMMAND "${COMPOSE_FILES[@]}" ps -q "$SERVICE" | wc -l)
  echo "$COUNT"
}

# Function to check if container is healthy
is_container_healthy() {
  local CONTAINER_ID="$1"
  local HEALTH_STATUS

  echo "Executing: docker $DOCKER_ARGS inspect --format='{{.State.Health.Status}}' $CONTAINER_ID"
  HEALTH_STATUS=$(docker $DOCKER_ARGS inspect --format='{{.State.Health.Status}}' "$CONTAINER_ID")
  [ "$HEALTH_STATUS" = "healthy" ]
}

# Function to get container age
get_container_age() {
  local CONTAINER_ID="$1"
  local AGE

  echo "Executing: docker $DOCKER_ARGS inspect --format='{{.Created}}' $CONTAINER_ID"
  AGE=$(docker $DOCKER_ARGS inspect --format='{{.Created}}' "$CONTAINER_ID")
  echo "$AGE"
}

# Function to get oldest containers
get_oldest_containers() {
  local SERVICE="$1"
  shift  # Remove service name from args
  local COUNT="$1"
  shift  # Remove count from args
  local COMPOSE_FILES=("$@")
  local CONTAINERS

  echo "Executing: $COMPOSE_COMMAND ${COMPOSE_FILES[*]} ps -q $SERVICE | xargs -I {} docker $DOCKER_ARGS inspect --format='{{.Id}} {{.Created}}' {} | sort -k2 | head -n $COUNT | cut -d' ' -f1"
  CONTAINERS=$($COMPOSE_COMMAND "${COMPOSE_FILES[@]}" ps -q "$SERVICE" | \
    xargs -I {} docker $DOCKER_ARGS inspect --format='{{.Id}} {{.Created}}' {} | \
    sort -k2 | head -n "$COUNT" | cut -d' ' -f1)
  echo "$CONTAINERS"
}

# Main rollout function
rollout_service() {
  local SERVICE="$1"
  shift  # Remove service name from args
  local COMPOSE_FILES=("$@")
  local TARGET_REPLICAS
  local STEP
  local CURRENT_REPLICAS
  local SCALE_DOWN
  local SCALE_UP
  local OLDEST_CONTAINERS
  local NEW_CONTAINERS
  local OLD_CONTAINERS
  local DRAIN_COUNT
  local TO_DRAIN

  echo "Starting rollout for service: $SERVICE"

  # Get target replicas and calculate step size
  TARGET_REPLICAS=$(get_target_replicas "$SERVICE" "${COMPOSE_FILES[@]}")
  STEP=$(calculate_step "$TARGET_REPLICAS")
  CURRENT_REPLICAS=$(get_current_replicas "$SERVICE" "${COMPOSE_FILES[@]}")

  echo "Target replicas: $TARGET_REPLICAS, Current replicas: $CURRENT_REPLICAS, Step size: $STEP"

  if [ "$CURRENT_REPLICAS" -gt "$TARGET_REPLICAS" ]; then
    # Scale down scenario
    while [ "$CURRENT_REPLICAS" -gt "$TARGET_REPLICAS" ]; do
      SCALE_DOWN=$((STEP < (CURRENT_REPLICAS - TARGET_REPLICAS) ? STEP : (CURRENT_REPLICAS - TARGET_REPLICAS)))
      OLDEST_CONTAINERS=$(get_oldest_containers "$SERVICE" "$SCALE_DOWN" "${COMPOSE_FILES[@]}")

      # Drain oldest containers
      for container in $OLDEST_CONTAINERS; do
        echo "Executing: docker $DOCKER_ARGS exec $container touch /tmp/drain"
        docker $DOCKER_ARGS exec "$container" touch /tmp/drain
      done

      sleep 30

      # Scale down
      echo "Executing: $COMPOSE_COMMAND ${COMPOSE_FILES[*]} up -d --scale $SERVICE=$((CURRENT_REPLICAS - SCALE_DOWN))"
      $COMPOSE_COMMAND "${COMPOSE_FILES[@]}" up -d --scale "$SERVICE=$((CURRENT_REPLICAS - SCALE_DOWN))"
      CURRENT_REPLICAS=$((CURRENT_REPLICAS - SCALE_DOWN))
      echo "Scaled down to $CURRENT_REPLICAS replicas"
    done
  elif [ "$CURRENT_REPLICAS" -lt "$TARGET_REPLICAS" ]; then
    # Scale up scenario
    while [ "$CURRENT_REPLICAS" -lt "$TARGET_REPLICAS" ]; do
      SCALE_UP=$((STEP < (TARGET_REPLICAS - CURRENT_REPLICAS) ? STEP : (TARGET_REPLICAS - CURRENT_REPLICAS)))

      # Scale up
      echo "Executing: $COMPOSE_COMMAND ${COMPOSE_FILES[*]} up -d --scale $SERVICE=$((CURRENT_REPLICAS + SCALE_UP))"
      $COMPOSE_COMMAND "${COMPOSE_FILES[@]}" up -d --scale "$SERVICE=$((CURRENT_REPLICAS + SCALE_UP))"

      # Wait for new containers to be healthy
      echo "Executing: $COMPOSE_COMMAND ${COMPOSE_FILES[*]} ps -q $SERVICE | tail -n $SCALE_UP"
      NEW_CONTAINERS=$($COMPOSE_COMMAND "${COMPOSE_FILES[@]}" ps -q "$SERVICE" | tail -n "$SCALE_UP")
      for container in $NEW_CONTAINERS; do
        while ! is_container_healthy "$container"; do
          sleep 5
        done
      done

      CURRENT_REPLICAS=$((CURRENT_REPLICAS + SCALE_UP))
      echo "Scaled up to $CURRENT_REPLICAS replicas"
    done
  fi

  # Handle any remaining old containers
  OLD_CONTAINERS=$(get_oldest_containers "$SERVICE" "$CURRENT_REPLICAS" "${COMPOSE_FILES[@]}")
  while [ -n "$OLD_CONTAINERS" ]; do
    DRAIN_COUNT=$((STEP < CURRENT_REPLICAS ? STEP : CURRENT_REPLICAS))
    TO_DRAIN=$(echo "$OLD_CONTAINERS" | head -n "$DRAIN_COUNT")

    # Drain containers
    for container in $TO_DRAIN; do
      echo "Executing: docker $DOCKER_ARGS exec $container touch /tmp/drain"
      docker $DOCKER_ARGS exec "$container" touch /tmp/drain
    done

    sleep 30

    # Scale down
    echo "Executing: $COMPOSE_COMMAND ${COMPOSE_FILES[*]} up -d --scale $SERVICE=$((CURRENT_REPLICAS - DRAIN_COUNT))"
    $COMPOSE_COMMAND "${COMPOSE_FILES[@]}" up -d --scale "$SERVICE=$((CURRENT_REPLICAS - DRAIN_COUNT))"
    CURRENT_REPLICAS=$((CURRENT_REPLICAS - DRAIN_COUNT))

    sleep 10

    # Scale back up if needed
    if [ "$CURRENT_REPLICAS" -lt "$TARGET_REPLICAS" ]; then
      echo "Executing: $COMPOSE_COMMAND ${COMPOSE_FILES[*]} up -d --scale $SERVICE=$TARGET_REPLICAS"
      $COMPOSE_COMMAND "${COMPOSE_FILES[@]}" up -d --scale "$SERVICE=$TARGET_REPLICAS"

      # Wait for new containers to be healthy
      echo "Executing: $COMPOSE_COMMAND ${COMPOSE_FILES[*]} ps -q $SERVICE | tail -n $((TARGET_REPLICAS - CURRENT_REPLICAS))"
      NEW_CONTAINERS=$($COMPOSE_COMMAND "${COMPOSE_FILES[@]}" ps -q "$SERVICE" | tail -n "$((TARGET_REPLICAS - CURRENT_REPLICAS))")
      for container in $NEW_CONTAINERS; do
        while ! is_container_healthy "$container"; do
          sleep 5
        done
      done

      CURRENT_REPLICAS=$TARGET_REPLICAS
    fi

    # Update old containers list
    OLD_CONTAINERS=$(get_oldest_containers "$SERVICE" "$CURRENT_REPLICAS" "${COMPOSE_FILES[@]}")
  done

  # Final check to ensure we have the correct number of replicas
  if [ "$(get_current_replicas "$SERVICE" "${COMPOSE_FILES[@]}")" -ne "$TARGET_REPLICAS" ]; then
    echo "Executing: $COMPOSE_COMMAND ${COMPOSE_FILES[*]} up -d --scale $SERVICE=$TARGET_REPLICAS"
    $COMPOSE_COMMAND "${COMPOSE_FILES[@]}" up -d --scale "$SERVICE=$TARGET_REPLICAS"
  fi

  echo "Rollout completed for service: $SERVICE"
}

usage() {
  cat <<EOF

Usage: docker rollout [OPTIONS] SERVICE [SERVICE...]

Gradually roll out updates to specified services.

Options:
  -h, --help                  Print usage
  -f, --file FILE             Compose configuration files
  -v, --version               Print plugin version

EOF
}

# Parse compose files and services
COMPOSE_FILES=()
SERVICES=()

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -f|--file)
      shift
      if [ -n "$1" ]; then
        COMPOSE_FILES+=("-f" "$1")
      fi
      ;;
    -v|--version)
      echo "docker-rollout version $VERSION"
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
    *)
      SERVICES+=("$1")
      ;;
  esac
  shift
done

# Require at least one service
if [ ${#SERVICES[@]} -eq 0 ]; then
  echo "At least one SERVICE is required"
  usage
  exit 1
fi

# Process each service
for service in "${SERVICES[@]}"; do
  echo "Processing service: $service"
  rollout_service "$service" "${COMPOSE_FILES[@]}"
done
