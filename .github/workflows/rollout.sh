#!/bin/sh
set -e

VERSION=v0.10

# Defaults
HEALTHCHECK_TIMEOUT=60
NO_HEALTHCHECK_TIMEOUT=10
WAIT_AFTER_HEALTHY_DELAY=0
GRADUAL_SCALE_PERCENT=10

# Print metadata for Docker CLI plugin
if [ "$1" = "docker-cli-plugin-metadata" ]; then
  cat <<EOF
{
  "SchemaVersion": "0.1.0",
  "Vendor": "Karol Musur",
  "Version": "$VERSION",
  "ShortDescription": "Rollout new Compose service version"
}
EOF
  exit
fi

# Save docker arguments, i.e. arguments before "rollout"
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

# Save environment variables for compose
for var in $(env | cut -d= -f1); do
  if [ "$var" != "DOCKER_ARGS" ] && [ "$var" != "COMPOSE_COMMAND" ]; then
    COMPOSE_ENV="$COMPOSE_ENV $var"
  fi
done

usage() {
  cat <<EOF

Usage: docker rollout [OPTIONS] SERVICE [SERVICE...]

Rollout new Compose service version for one or more services.

Options:
  -h, --help                  Print usage
  -f, --file FILE             Compose configuration files
  -t, --timeout N             Healthcheck timeout (default: $HEALTHCHECK_TIMEOUT seconds)
  -w, --wait N                When no healthcheck is defined, wait for N seconds
                              before stopping old container (default: $NO_HEALTHCHECK_TIMEOUT seconds)
      --wait-after-healthy N  When healthcheck is defined and succeeds, wait for additional N seconds
                              before stopping the old container (default: 0 seconds)
      --env-file FILE         Specify an alternate environment file
  -v, --version               Print plugin version
  --pre-stop-hook CMD         Run a command in the old container before stopping it.
  --gradual-scale N           Percentage of containers to replace at once (default: $GRADUAL_SCALE_PERCENT)

EOF
}

exit_with_usage() {
  usage
  exit 1
}

healthcheck() {
  # shellcheck disable=SC2086 # DOCKER_ARGS must be unquoted to allow multiple arguments
  docker $DOCKER_ARGS inspect --format='{{json .State.Health.Status}}' "$1" | grep -v "unhealthy" | grep -q "healthy"
}

scale() {
  # shellcheck disable=SC2086 # COMPOSE_FILES and ENV_FILES must be unquoted to allow multiple files
  $COMPOSE_COMMAND $COMPOSE_FILES $ENV_FILES up --detach --scale "$1=$2" --no-recreate "$1"
}

wait_for_health() {
  local NEW_CONTAINER_IDS="$1"
  local SCALE="$2"
  local SUCCESS=0

  echo "==> Waiting for new containers to be healthy (timeout: $HEALTHCHECK_TIMEOUT seconds)"
  for _ in $(seq 1 "$HEALTHCHECK_TIMEOUT"); do
    SUCCESS=0

    for NEW_CONTAINER_ID in $NEW_CONTAINER_IDS; do
      if healthcheck "$NEW_CONTAINER_ID"; then
        SUCCESS=$((SUCCESS + 1))
      fi
    done

    if [ "$SUCCESS" = "$SCALE" ]; then
      break
    fi

    sleep 1
  done

  SUCCESS=0

  for NEW_CONTAINER_ID in $NEW_CONTAINER_IDS; do
    if healthcheck "$NEW_CONTAINER_ID"; then
      SUCCESS=$((SUCCESS + 1))
    fi
  done

  if [ "$SUCCESS" != "$SCALE" ]; then
    for NEW_CONTAINER_ID in $NEW_CONTAINER_IDS; do
      echo "==> Health check status for container $NEW_CONTAINER_ID"

      # shellcheck disable=SC2086 # DOCKER_ARGS must be unquoted to allow multiple arguments
      docker $DOCKER_ARGS inspect --format='{{json .State.Health}}' "$NEW_CONTAINER_ID"
    done

    echo "==> New containers are not healthy. Rolling back." >&2

    docker $DOCKER_ARGS stop $NEW_CONTAINER_IDS
    docker $DOCKER_ARGS rm $NEW_CONTAINER_IDS

    return 1
  fi

  if [ "$WAIT_AFTER_HEALTHY_DELAY" != "0" ]; then
    echo "==> Waiting for healthy containers to settle down ($WAIT_AFTER_HEALTHY_DELAY seconds)"
    sleep $WAIT_AFTER_HEALTHY_DELAY
  fi

  return 0
}

get_container_ids() {
  local SERVICE="$1"
  # shellcheck disable=SC2086 # COMPOSE_FILES and ENV_FILES must be unquoted to allow multiple files
  $COMPOSE_COMMAND $COMPOSE_FILES $ENV_FILES ps --quiet "$SERVICE" | tr '\n' ' '
}

get_target_replicas() {
  local SERVICE="$1"
  # Get the full config with all compose files and environment variables
  local FULL_CONFIG=$($COMPOSE_COMMAND $COMPOSE_FILES $ENV_FILES config)
  # Find the service section and get the first replicas value after it
  local TARGET_REPLICAS=$(echo "$FULL_CONFIG" | sed -n "/^services:$/,/^[a-z]/p" | grep -A100 "^  $SERVICE:" | grep -o 'replicas: [0-9]*' | head -n1 | cut -d' ' -f2)

  # Default to 1 if no value found
  if [ -z "$TARGET_REPLICAS" ]; then
    TARGET_REPLICAS=1
  fi

  echo "$TARGET_REPLICAS"
}

gradual_scale() {
  local SERVICE="$1"
  local OLD_CONTAINER_IDS="$2"
  local TOTAL_SCALE="$3"
  local CURRENT_SCALE="$4"
  local SCALE_STEP="$5"
  local NEW_CONTAINER_IDS=""
  local OLD_CONTAINER_IDS_TO_REMOVE=""

  echo "==> Debug: gradual_scale parameters:"
  echo "  SERVICE: $SERVICE"
  echo "  OLD_CONTAINER_IDS: $OLD_CONTAINER_IDS"
  echo "  TOTAL_SCALE: $TOTAL_SCALE"
  echo "  CURRENT_SCALE: $CURRENT_SCALE"
  echo "  SCALE_STEP: $SCALE_STEP"

  # Step 1: Increase scale by STEP
  local TARGET_COUNT=$((CURRENT_SCALE + SCALE_STEP))
  echo "==> Adding $SCALE_STEP new containers (target: $TARGET_COUNT)"
  scale "$SERVICE" $TARGET_COUNT

  # Wait a moment for new containers to be created
  sleep 2

  # Get all current container IDs
  local ALL_CONTAINER_IDS=$(get_container_ids "$SERVICE")
  if [ -z "$ALL_CONTAINER_IDS" ]; then
    echo "==> Failed to get container IDs after scaling up"
    return 1
  fi

  # Get new container IDs by finding containers not in the old list
  NEW_CONTAINER_IDS=""
  for CID in $ALL_CONTAINER_IDS; do
    if ! echo "$OLD_CONTAINER_IDS" | grep -q "$CID"; then
      NEW_CONTAINER_IDS="$NEW_CONTAINER_IDS $CID"
    fi
  done
  # Trim leading space
  NEW_CONTAINER_IDS=$(echo "$NEW_CONTAINER_IDS" | sed 's/^ *//')

  # Verify we got the expected number of new containers
  local NEW_COUNT=$(echo "$NEW_CONTAINER_IDS" | wc -w | tr -d ' ')
  if [ "$NEW_COUNT" != "$SCALE_STEP" ]; then
    echo "==> Expected $SCALE_STEP new containers but got $NEW_COUNT"
    return 1
  fi

  # Step 2: Wait for new containers to be healthy
  if [ -n "$NEW_CONTAINER_IDS" ]; then
    # Check if containers have healthcheck
    # shellcheck disable=SC2086 # DOCKER_ARGS must be unquoted to allow multiple arguments
    if docker $DOCKER_ARGS inspect --format='{{json .State.Health}}' "$(echo $NEW_CONTAINER_IDS | cut -d\  -f 1)" | grep -q "Status"; then
      if ! wait_for_health "$NEW_CONTAINER_IDS" "$SCALE_STEP"; then
        return 1
      fi
    else
      echo "==> Waiting for new containers to be ready ($NO_HEALTHCHECK_TIMEOUT seconds)"
      sleep "$NO_HEALTHCHECK_TIMEOUT"
    fi
  fi

  # Step 3: Get the oldest containers to remove
  if [ -n "$OLD_CONTAINER_IDS" ]; then
    # shellcheck disable=SC2086 # DOCKER_ARGS must be unquoted to allow multiple arguments
    OLD_CONTAINER_IDS_TO_REMOVE=$(docker $DOCKER_ARGS inspect --format='{{.Id}}' $OLD_CONTAINER_IDS | sort -r | head -n "$SCALE_STEP" | sort -u | tr '\n' ' ')

    # Verify we got the expected number of old containers to remove
    local OLD_COUNT=$(echo "$OLD_CONTAINER_IDS_TO_REMOVE" | wc -w | tr -d ' ')
    if [ "$OLD_COUNT" != "$SCALE_STEP" ]; then
      echo "==> Expected $SCALE_STEP old containers to remove but got $OLD_COUNT"
      return 1
    fi

    # Step 4: Run pre-stop hook on old containers
    if [ -n "$PRE_STOP_HOOK" ]; then
      echo "==> Running pre-stop hook: $PRE_STOP_HOOK"
      for OLD_CONTAINER_ID in $OLD_CONTAINER_IDS_TO_REMOVE; do
        # shellcheck disable=SC2086 # DOCKER_ARGS must be unquoted to allow multiple arguments
        docker $DOCKER_ARGS exec "$OLD_CONTAINER_ID" sh -c "$PRE_STOP_HOOK"
      done
      # Wait 30 seconds as specified
      echo "==> Waiting 30 seconds after pre-stop hook"
      sleep 30
    fi

    # Step 5: Scale down by STEP
    echo "==> Scaling down by $SCALE_STEP"
    scale "$SERVICE" $CURRENT_SCALE
  fi

  return 0
}

rollout_service() {
  local SERVICE="$1"
  local FAILED=0

  echo "==> Processing service: $SERVICE"

  # Get target number of replicas from docker-compose config
  local TARGET_REPLICAS=$(get_target_replicas "$SERVICE")
  echo "==> Debug: Target replicas from docker-compose: $TARGET_REPLICAS"

  # Get initial container IDs
  local INITIAL_CONTAINER_IDS=$(get_container_ids "$SERVICE")
  if [ -z "$INITIAL_CONTAINER_IDS" ]; then
    echo "==> Service '$SERVICE' is not running. Starting the service."
    # For new services, start with target replicas
    scale "$SERVICE" $TARGET_REPLICAS
    sleep 2
    INITIAL_CONTAINER_IDS=$(get_container_ids "$SERVICE")
    if [ -z "$INITIAL_CONTAINER_IDS" ]; then
      echo "==> Failed to start service '$SERVICE'"
      return 1
    fi
    # For new services, we're already at target replicas, no need to continue
    return 0
  fi

  # Get the current number of running containers
  local CURRENT_CONTAINERS=$(echo "$INITIAL_CONTAINER_IDS" | wc -w | tr -d ' ')
  echo "==> Debug: Current number of containers: $CURRENT_CONTAINERS"

  # If we have fewer containers than target, scale up first
  if [ "$CURRENT_CONTAINERS" -lt "$TARGET_REPLICAS" ]; then
    echo "==> Scaling up to target replicas first"
    scale "$SERVICE" $TARGET_REPLICAS
    sleep 2
    INITIAL_CONTAINER_IDS=$(get_container_ids "$SERVICE")
    CURRENT_CONTAINERS=$(echo "$INITIAL_CONTAINER_IDS" | wc -w | tr -d ' ')
  fi

  local OLD_CONTAINER_IDS="$INITIAL_CONTAINER_IDS"
  local TOTAL_SCALE=$TARGET_REPLICAS
  local CURRENT_SCALE=$CURRENT_CONTAINERS
  local SCALE_STEP=$(( (TOTAL_SCALE * GRADUAL_SCALE_PERCENT + 99) / 100 )) # Ceiling division

  # Ensure minimum step size of 1
  if [ "$SCALE_STEP" -lt 1 ]; then
    SCALE_STEP=1
  fi

  echo "==> Debug: Starting rollout with:"
  echo "  Target replicas: $TOTAL_SCALE"
  echo "  Current scale: $CURRENT_SCALE"
  echo "  Scale step: $SCALE_STEP"

  # Keep track of remaining old containers
  local REMAINING_OLD_CONTAINERS="$OLD_CONTAINER_IDS"
  local ITERATION=0

  # Continue until no old containers remain
  while [ -n "$REMAINING_OLD_CONTAINERS" ]; do
    echo "==> Debug: Remaining old containers: $REMAINING_OLD_CONTAINERS"
    echo "==> Debug: Current scale: $CURRENT_SCALE"

    # Adjust step size for the last iteration if needed
    local CURRENT_STEP=$SCALE_STEP
    local REMAINING_COUNT=$(echo "$REMAINING_OLD_CONTAINERS" | wc -w | tr -d ' ')
    if [ "$REMAINING_COUNT" -lt "$SCALE_STEP" ]; then
      CURRENT_STEP=$REMAINING_COUNT
    fi

    if ! gradual_scale "$SERVICE" "$REMAINING_OLD_CONTAINERS" "$TOTAL_SCALE" "$CURRENT_SCALE" "$CURRENT_STEP"; then
      return 1
    fi

    CURRENT_SCALE=$((CURRENT_SCALE + CURRENT_STEP))
    ITERATION=$((ITERATION + 1))

    # Update remaining old containers by removing the ones we just replaced
    if [ -n "$REMAINING_OLD_CONTAINERS" ]; then
      # shellcheck disable=SC2086 # DOCKER_ARGS must be unquoted to allow multiple arguments
      REMAINING_OLD_CONTAINERS=$(docker $DOCKER_ARGS inspect --format='{{.Id}}' $REMAINING_OLD_CONTAINERS | sort -r | tail -n +$((CURRENT_STEP + 1)) | tr '\n' ' ')
    fi
  done

  # Final scale to ensure we have exactly the target number of replicas
  if [ "$CURRENT_SCALE" -gt "$TOTAL_SCALE" ]; then
    echo "==> Scaling down to target replicas ($TOTAL_SCALE)"
    scale "$SERVICE" $TOTAL_SCALE
  fi

  return 0
}

main() {
  local SERVICES=""
  local FAILED=0

  # Collect all services
  while [ $# -gt 0 ]; do
    case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    -f | --file)
      COMPOSE_FILES="$COMPOSE_FILES -f $2"
      shift 2
      ;;
    --env-file)
      ENV_FILES="$ENV_FILES --env-file $2"
      shift 2
      ;;
    -t | --timeout)
      HEALTHCHECK_TIMEOUT="$2"
      shift 2
      ;;
    -w | --wait)
      NO_HEALTHCHECK_TIMEOUT="$2"
      shift 2
      ;;
    --wait-after-healthy)
      WAIT_AFTER_HEALTHY_DELAY="$2"
      shift 2
      ;;
    --pre-stop-hook)
      PRE_STOP_HOOK="$2"
      shift 2
      ;;
    --gradual-scale)
      GRADUAL_SCALE_PERCENT="$2"
      shift 2
      ;;
    -v | --version)
      echo "docker-rollout version $VERSION"
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      exit_with_usage
      ;;
    *)
      SERVICES="$SERVICES $1"
      shift
      ;;
    esac
  done

  # Remove leading space from SERVICES
  SERVICES=$(echo "$SERVICES" | sed 's/^ *//')

  # Require at least one SERVICE argument
  if [ -z "$SERVICES" ]; then
    echo "At least one SERVICE is required"
    exit_with_usage
  fi

  # Process each service
  for SERVICE in $SERVICES; do
    if ! rollout_service "$SERVICE"; then
      # Check if this is a one-off service that completed successfully
      # shellcheck disable=SC2086 # COMPOSE_FILES and ENV_FILES must be unquoted to allow multiple files
      if $COMPOSE_COMMAND $COMPOSE_FILES $ENV_FILES ps --quiet "$SERVICE" | grep -q .; then
        echo "==> Failed to rollout service: $SERVICE"
        FAILED=1
      else
        echo "==> Service $SERVICE completed successfully"
      fi
    fi
  done

  if [ $FAILED -eq 1 ]; then
    exit 1
  fi
}

main "$@"
