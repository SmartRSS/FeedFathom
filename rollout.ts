import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Time in milliseconds between health checks */
const healthcheckInterval = 500;

// Global variables
const composeFiles: string[] = [];

// Add type definitions at the top of the file
interface Container {
  ID: string;
  Name: string;
  CreatedAt: string;
  State: string;
  Status: string;
  Health?: string;
  // Add fields from docker compose ps output
  Command?: string;
  ExitCode?: number;
  Image?: string;
  Labels?: string;
  LocalVolumes?: string;
  Mounts?: string;
  Names?: string;
  Networks?: string;
  Ports?: string;
  Project?: string;
  Publishers?: Array<{
    URL: string;
    TargetPort: number;
    PublishedPort: number;
    Protocol: string;
  }>;
  RunningFor?: string;
  Service?: string;
  Size?: string;
}

// Centralized logging functions
function logInfo(message: string): void {
  console.log(message);
}

function logError(message: string): void {
  console.error(message);
}

// Utility functions for Docker operations
async function executeDockerCommand(command: string, log = false) {
  try {
    const { stdout, stderr } = await execAsync(command);
    if (stderr) {
      logError(stderr);
    }
    if (log) {
      logInfo(stdout);
    }
    return stdout;
  } catch (error) {
    logError(`Command failed: ${command}`);
    throw error;
  }
}

async function executeComposeCommand(command: string) {
  const composeArgs = composeFiles
    .map((file) => {
      if (!file.trim()) {
        throw new Error("Empty compose file path");
      }
      return `-f "${file}"`;
    })
    .join(" ");
  return executeDockerCommand(`docker compose ${composeArgs} ${command}`);
}

// Function to get target replicas for all services from compose config
async function getTargetReplicasMap(services: string[]) {
  try {
    const config = await executeComposeCommand("config --format json");
    const parsedConfig = JSON.parse(config);
    const replicasMap = new Map<string, number>();
    for (const service of services) {
      const serviceConfig = (
        parsedConfig as {
          services: Record<string, { deploy?: { replicas?: number } }>;
        }
      ).services[service];
      if (!serviceConfig) {
        throw new Error(`Service ${service} not found in compose config`);
      }
      const replicas = serviceConfig.deploy?.replicas ?? 1;
      if (typeof replicas !== "number" || replicas < 0) {
        throw new Error(`Invalid replica count for service ${service}`);
      }
      replicasMap.set(service, replicas);
    }
    return replicasMap;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Invalid compose config JSON");
    }
    throw error;
  }
}

// Function to calculate step size (10% of target replicas, rounded up)
function calculateStep(target: number) {
  return Math.ceil(target / 4);
}

/**
 * Parses a JSON Lines (JSONL) string into an array of objects
 * @param jsonlString The JSONL string to parse
 * @param context Context information for error messages
 * @returns Array of parsed objects
 */
function parseJSONL<T>(jsonlString: string, context: string): T[] {
  if (!jsonlString || typeof jsonlString !== "string") {
    throw new Error(`Empty or invalid response for ${context}`);
  }

  // Split the result by newlines and parse each line as JSON
  const lines = jsonlString.trim().split("\n");
  return lines
    .filter((line) => line.trim() !== "") // Filter out empty lines
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (parseError) {
        logError(
          `Failed to parse JSON at line ${index + 1}: ${line.substring(0, 100)}...`,
        );
        throw new Error(
          `Invalid JSON for ${context} at line ${index + 1}: ${(parseError as Error).message}`,
        );
      }
    });
}

// Function to get current number of replicas
async function getCurrentReplicas(service: string) {
  try {
    const result = await executeComposeCommand(`ps ${service} --format json`);
    const containers = parseJSONL<Container>(result, `service ${service}`);
    return containers.length;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to get replicas for service ${service}: ${error.message}`,
      );
    }
    throw new Error(`Unknown error getting replicas for service ${service}`);
  }
}

// Function to check if container is healthy
async function compareContainerStatus(
  containerId: string,
  expectedStatus: string,
) {
  try {
    const result = await executeComposeCommand("ps --format json");
    const containers = parseJSONL<Container>(result, "container status");
    const container = containers.find((c) => c.ID === containerId);

    if (!container) {
      return false;
    }

    const containerHealth = container?.Health?.toLowerCase() || "";
    return containerHealth === expectedStatus.toLowerCase();
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("No such container")) {
      // If container doesn't exist, consider it unhealthy
      return false;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Shared helper – parse the "CreatedAt" field that Docker prints in
// `docker compose ps --format json`.
// Example format: "2025-04-03 09:30:05 +0200 CEST"
// Returns a numeric timestamp (ms since epoch) or throws on malformed input.
function parseDockerDate(dateStr: string | undefined): number {
  if (!dateStr) {
    throw new Error("Missing creation date");
  }

  // Replace first space with T to make the string ISO-like and strip the TZ suffix
  // "2025-04-03 09:30:05 +0200 CEST" -> "2025-04-03T09:30:05"
  const isoDate = dateStr.replace(" ", "T").split(" ")[0];
  if (!isoDate) {
    throw new Error(`Invalid date format: ${dateStr}`);
  }

  const ts = new Date(isoDate).getTime();
  if (Number.isNaN(ts)) {
    throw new Error(`Unable to parse container creation date: ${dateStr}`);
  }

  return ts;
}

// Function to get containers sorted by age
async function getContainersByAge(
  service: string,
  count: number,
  ascending = true,
): Promise<string[]> {
  try {
    const result = await executeComposeCommand(`ps ${service} --format json`);

    const containers = parseJSONL<Container>(result, `service ${service}`);

    // Filter out non-running containers
    const runningContainers = containers.filter((c) => c.State === "running");

    if (runningContainers.length === 0) {
      return [];
    }

    const sortedContainers = runningContainers
      .sort((a, b) => {
        try {
          const timeA = parseDockerDate(a.CreatedAt);
          const timeB = parseDockerDate(b.CreatedAt);
          return ascending ? timeA - timeB : timeB - timeA;
        } catch (error) {
          logError(`Error parsing dates: ${a.CreatedAt} and ${b.CreatedAt}`);
          throw new Error(
            `Invalid container creation timestamp: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })
      .slice(0, count);

    return sortedContainers.map((c) => c.ID);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to get containers for service ${service}: ${error.message}`,
      );
    }
    throw new Error(`Unknown error getting containers for service ${service}`);
  }
}

// Function to get oldest containers
async function getOldestContainers(
  service: string,
  count: number,
): Promise<string[]> {
  return await getContainersByAge(service, count, true);
}

// Function to get latest containers
async function getLatestContainers(
  service: string,
  count: number,
): Promise<string[]> {
  return await getContainersByAge(service, count, false);
}

// NEW HELPER: Resolve the desired image ID (immutable digest) for a service
async function getDesiredImageId(service: string): Promise<string> {
  // docker compose config --images already performs env-var substitution
  const repoAndTag = (
    await executeComposeCommand(`config --images ${service}`)
  ).trim();

  // Turn the tag into its sha256 digest so we can compare reliably
  const imageInspect = await executeDockerCommand(
    `docker image inspect ${repoAndTag} --format '{{.Id}}'`,
  );
  const desiredImageId = imageInspect.trim();
  if (!desiredImageId) {
    throw new Error(`Could not resolve image ID for service ${service}`);
  }
  return desiredImageId;
}

// NEW HELPER: Return running containers whose ImageID differs from desired
async function getOutdatedContainers(
  service: string,
  desiredImageId: string,
): Promise<string[]> {
  const result = await executeComposeCommand(`ps ${service} --format json`);
  const containers = parseJSONL<Container>(result, `service ${service}`);

  const outdated: { id: string; created: number }[] = [];
  for (const container of containers) {
    if (container.State !== "running") continue;
    // docker inspect returns the ImageID the container was started with
    const imageId = (
      await executeDockerCommand(
        `docker inspect ${container.ID} --format '{{.Image}}'`,
      )
    ).trim();
    if (imageId !== desiredImageId) {
      let createdTs: number;
      try {
        createdTs = parseDockerDate(container.CreatedAt);
      } catch (error) {
        // Log and skip containers with invalid timestamps to avoid unpredictable ordering
        logError(
          `Skipping container ${container.ID} due to invalid CreatedAt: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      outdated.push({ id: container.ID, created: createdTs });
    }
  }

  // Sort oldest first so rollout replaces oldest replicas first
  outdated.sort((a, b) => a.created - b.created);
  return outdated.map((o) => o.id);
}

async function waitForContainerStatus(
  containers: string[],
  status: string,
  timeoutMs = 30000,
) {
  const existingContainers: Container[] = [];
  const startTime = Date.now();

  // First filter out containers that no longer exist
  for (const container of containers) {
    const result = await executeComposeCommand("ps --format json");
    const containerInfo = parseJSONL<Container>(result, "container status");
    const foundContainer = containerInfo.find(
      (c: Container) => c.ID === container,
    );
    if (foundContainer?.State === "running") {
      existingContainers.push(foundContainer);
    } else {
      logInfo(`Container ${container} is not running, skipping health check`);
    }
  }

  if (existingContainers.length === 0) {
    logInfo("No running containers to check health status");
    return;
  }

  // Check initial status of all containers
  const unhealthyContainers: string[] = [];
  for (const container of existingContainers) {
    const isHealthy = await compareContainerStatus(container.ID, status);
    if (!isHealthy) {
      unhealthyContainers.push(container.ID);
    }
  }

  for (const containerId of unhealthyContainers) {
    while (!(await compareContainerStatus(containerId, status))) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(
          `Timeout waiting for container ${containerId} to become ${status}`,
        );
      }
      await Bun.sleep(healthcheckInterval);
    }
    logInfo(`Container ${containerId} became ${status}`);
  }
}

// Function to drain containers
async function drainContainers(containers: string[]) {
  if (!containers || containers.length === 0) {
    logInfo("No containers to drain");
    return;
  }

  logInfo(`Draining containers ${containers.join(" ")}`);

  // Set maintenance mode for each container
  for (const containerId of containers) {
    try {
      // Send POST request to enable maintenance mode using curl
      await executeDockerCommand(
        `docker exec ${containerId} curl --fail -s -X POST -H "Content-Type: application/json" -d '{"maintenance":true}' http://localhost:3000/maintenance`,
      );

      logInfo(`Enabled maintenance mode for container ${containerId}`);
    } catch (error) {
      logError(
        `Failed to enable maintenance mode for container ${containerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}

async function gracefulShutdown(containers: string[]) {
  // Drain and stop the old containers
  await drainContainers(containers);
  await waitForContainerStatus(containers, "unhealthy");
  await stopDrainedContainers(containers);
  await removeContainers(containers);
}

// Helper function to stop drained containers
async function stopDrainedContainers(containers: string[]): Promise<void> {
  if (!containers || containers.length === 0) {
    logInfo("No containers to stop");
    return;
  }

  logInfo(`Stopping containers ${containers.join(" ")}`);

  // Stop the containers
  await executeDockerCommand(`docker stop ${containers.join(" ")}`);
}

// Function to scale service
async function scaleService(service: string, replicas: number) {
  if (!Number.isInteger(replicas) || replicas < 0) {
    throw new Error("Replica count must be a non-negative integer");
  }
  logInfo(`Scaling service ${service} to ${replicas} replicas`);

  // use --no-recreate to prevent old replicas from being replaced
  // use --no-deps to prevent starting migrator every time
  await executeComposeCommand(
    `up -d --scale ${service}=${replicas} --no-recreate --no-deps > /dev/null 2>&1`,
  );

  // Wait a moment for containers to start
  await Bun.sleep(1000);

  const actualReplicas = await getCurrentReplicas(service);
  if (actualReplicas !== replicas) {
    throw new Error(
      `Failed to scale service ${service} to ${replicas} replicas (got ${actualReplicas})`,
    );
  }
}

// Function to get service type from compose config
async function getServiceType(
  service: string,
): Promise<"one-off" | "long-running"> {
  try {
    const config = await executeComposeCommand("config --format json");
    const parsedConfig = JSON.parse(config);
    const serviceConfig = (
      parsedConfig as {
        services: Record<
          string,
          {
            deploy?: {
              replicas?: number;
            };
            healthcheck?: Record<string, unknown>;
            restart?: string;
            command?: string | string[];
            entrypoint?: string | string[];
          }
        >;
      }
    ).services[service];

    if (!serviceConfig) {
      throw new Error(`Service ${service} not found in compose config`);
    }

    // Heuristic 1: If service has no healthcheck, it might be one-off
    if (!serviceConfig.healthcheck) {
      return "one-off";
    }

    // Heuristic 2: If restart policy is "no", "on-failure", or not defined, it might be one-off
    if (
      serviceConfig.restart === "no" ||
      serviceConfig.restart === "on-failure" ||
      !serviceConfig.restart
    ) {
      return "one-off";
    }

    // Heuristic 3: If service has a command that looks like a one-off task
    const command = serviceConfig.command;
    if (command) {
      const cmdStr = Array.isArray(command) ? command.join(" ") : command;
      const oneOffIndicators = [
        "backup",
        "migrate",
        "seed",
        "init",
        "setup",
        "cleanup",
        "import",
        "export",
      ];

      if (
        oneOffIndicators.some((indicator) =>
          cmdStr.toLowerCase().includes(indicator),
        )
      ) {
        return "one-off";
      }
    }

    // Default to long-running if no one-off indicators are found
    return "long-running";
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Invalid compose config JSON");
    }
    throw error;
  }
}

// Function to run one-off service
async function runOneOffService(service: string): Promise<void> {
  logInfo(`Running one-off service: ${service}`);
  try {
    // Run the service and wait for it to complete
    // Use --rm to automatically remove the container when it exits
    // Use --quiet-pull to avoid pulling messages
    // Redirect stderr to stdout to capture all output
    const output = await executeComposeCommand(
      `run --rm --quiet-pull ${service} 2>&1`,
    );

    // Log the output for debugging
    if (output.trim()) {
      logInfo(`Service output: ${output}`);
    }

    logInfo(`One-off service ${service} completed successfully`);
  } catch (error) {
    // Check if the error is due to a non-zero exit code
    if (error instanceof Error && error.message.includes("exit code")) {
      logError(
        `One-off service ${service} failed with non-zero exit code: ${error.message}`,
      );
    } else {
      logError(
        `One-off service ${service} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
}

// Helper function to remove containers
async function removeContainers(containers: string[]): Promise<void> {
  if (!containers || containers.length === 0) {
    logInfo("No containers to remove");
    return;
  }
  logInfo(`Removing containers ${containers.join(" ")}`);
  await executeDockerCommand(`docker rm ${containers.join(" ")}`);
}

// Main rollout function

async function rolloutService(service: string, targetReplicas: number) {
  logInfo(
    `[rolloutService] Enter: service=${service}, targetReplicas=${targetReplicas}`,
  );
  try {
    // Determine service type
    const serviceType = await getServiceType(service);
    logInfo(`[rolloutService] serviceType for ${service}: ${serviceType}`);

    if (serviceType === "one-off") {
      // Handle one-off service
      logInfo(`[rolloutService] Handling one-off service: ${service}`);
      await handleOneOffService(service);
      logInfo(
        `[rolloutService] One-off service ${service} handled successfully`,
      );
      return;
    }

    // Handle scale-to-zero case
    if (targetReplicas === 0) {
      logInfo(
        `[rolloutService] Target replicas for service ${service} is 0. Draining, stopping, and removing all containers.`,
      );
      // Get all running containers for the service
      let currentReplicas = 0;
      let runningContainers: string[] = [];
      try {
        currentReplicas = await getCurrentReplicas(service);
        logInfo(
          `[rolloutService] ${service} has ${currentReplicas} running containers`,
        );
        runningContainers = await getOldestContainers(service, currentReplicas);
      } catch (error) {
        logInfo(
          `[rolloutService] Could not get running containers for ${service} (service may not be running): ${error instanceof Error ? error.message : String(error)}. Treating as zero running containers.`,
        );
        runningContainers = [];
      }
      if (runningContainers.length > 0) {
        logInfo(
          `[rolloutService] Gracefully shutting down containers: ${runningContainers.join(", ")}`,
        );
        await gracefulShutdown(runningContainers);
        logInfo(
          `[rolloutService] Service ${service} successfully drained, stopped, and removed all containers.`,
        );
      } else {
        logInfo(
          `[rolloutService] No running containers found for service ${service}.`,
        );
      }
      logInfo(
        `[rolloutService] Exit: service=${service}, targetReplicas=${targetReplicas}`,
      );
      return;
    }

    // Handle long-running service (existing logic)
    const step = calculateStep(targetReplicas);
    let initialReplicas = 0;
    let oldContainers: string[] = [];
    try {
      initialReplicas = await getCurrentReplicas(service);
      const desiredImageId = await getDesiredImageId(service);
      oldContainers = await getOutdatedContainers(service, desiredImageId);
      logInfo(
        `[rolloutService] Target replicas: ${targetReplicas}, Current replicas: ${initialReplicas}, Step size: ${step}`,
      );
      logInfo(
        `[rolloutService] Identified ${oldContainers.length} out-of-date containers to be replaced`,
      );

      // If desired replica count is already met *and* every running container is on the desired image,
      // there is nothing to do for long-running services.  Otherwise continue so we can
      // scale up/down or replace outdated replicas.
      if (oldContainers.length === 0 && initialReplicas === targetReplicas) {
        logInfo(
          `[rolloutService] Service ${service} is already at ${targetReplicas} replicas running the desired image. Skipping rollout.`,
        );
        logInfo(
          `[rolloutService] Exit: service=${service}, targetReplicas=${targetReplicas}`,
        );
        return;
      }
    } catch (error) {
      logInfo(
        `[rolloutService] Could not get running containers for ${service} (service may not be running): ${error instanceof Error ? error.message : String(error)}. Treating as zero running containers.`,
      );
      initialReplicas = 0;
      oldContainers = [];
      logInfo(
        `[rolloutService] Target replicas: ${targetReplicas}, Current replicas: 0, Step size: ${step}`,
      );
      logInfo("[rolloutService] Identified 0 old containers to be replaced");
    }

    // -------------------------------------------------------------------
    // Phase 1 – SCALE DOWN to the desired replica count before we start
    // replacing images. We prefer draining outdated containers first, but
    // if there are still excess replicas beyond `targetReplicas`, we will
    // gracefully drain up-to-date containers chosen from the oldest ones.

    if (initialReplicas > targetReplicas) {
      let remainingToDrain = initialReplicas - targetReplicas;

      // Build a cache of all running containers ordered by age (oldest first)
      let allByAge: string[] = [];

      while (remainingToDrain > 0) {
        const batch = Math.min(step, remainingToDrain);

        // Take outdated containers first
        const fromOutdated = oldContainers.splice(0, batch);

        let toDrain = [...fromOutdated];

        if (toDrain.length < batch) {
          // Lazy-load the full list once – we only need it if we still have
          // to choose additional replicas to drain.
          if (allByAge.length === 0) {
            allByAge = await getOldestContainers(service, initialReplicas);
          }

          const needed = batch - toDrain.length;
          const extra = allByAge
            .filter(
              (id) => !toDrain.includes(id) && !oldContainers.includes(id),
            )
            .slice(0, needed);
          toDrain.push(...extra);

          // Ensure we don't drain the same container twice in subsequent batches
          allByAge = allByAge.filter((id) => !toDrain.includes(id));
        }

        logInfo(
          `[rolloutService] Phase 1: Scaling down by ${toDrain.length} containers`,
        );
        await gracefulShutdown(toDrain);

        remainingToDrain -= toDrain.length;
      }

      // After scale-down, update bookkeeping variables
      initialReplicas = targetReplicas;
    }

    // Phase 2: Replace remaining containers with new ones
    while (oldContainers.length > 0) {
      const scaleDelta = Math.min(step, oldContainers.length);
      // Scale up with new containers
      const upScale = targetReplicas + scaleDelta;
      logInfo(
        `[rolloutService] Phase 2: Scaling up to ${upScale} replicas (adding ${scaleDelta} new containers)`,
      );

      await scaleService(service, upScale);

      // Get and wait for the new containers to be healthy
      const newContainers = await getLatestContainers(service, scaleDelta);
      logInfo(
        `[rolloutService] New containers created: ${newContainers.join(" ")}`,
      );

      try {
        logInfo(
          `[rolloutService] Waiting for healthy containers ${newContainers.join(" ")}`,
        );
        await waitForContainerStatus(newContainers, "healthy", 30000); // 30 second timeout
      } catch (error) {
        if (error instanceof Error && error.message.includes("Timeout")) {
          logError(
            `[rolloutService] Timeout waiting for containers to become healthy: ${error.message}`,
          );
          // Get current replicas to see what actually started
          const currentReplicas = await getCurrentReplicas(service);
          if (currentReplicas < upScale) {
            logError(
              `[rolloutService] Only ${currentReplicas} containers started out of ${upScale} requested`,
            );
            throw new Error(
              `[rolloutService] Failed to start all containers: only ${currentReplicas} started`,
            );
          }
        }
        throw error;
      }

      await gracefulShutdown(oldContainers.splice(0, scaleDelta));
    }

    // Final adjustment if needed
    const currentReplicas = await getCurrentReplicas(service);
    if (currentReplicas !== targetReplicas) {
      logInfo(
        `[rolloutService] Final adjustment: scaling to ${targetReplicas} replicas`,
      );
      await scaleService(service, targetReplicas);
      // Get and wait for the new containers to be healthy
      const newContainers = await getLatestContainers(
        service,
        targetReplicas - currentReplicas,
      );

      try {
        logInfo(
          `[rolloutService] Waiting for healthy containers ${newContainers.join(" ")}`,
        );
        await waitForContainerStatus(newContainers, "healthy", 30000); // 30 second timeout
      } catch (error) {
        if (error instanceof Error && error.message.includes("Timeout")) {
          logError(
            `[rolloutService] Timeout waiting for containers to become healthy: ${error.message}`,
          );
          // Get current replicas to see what actually started
          const actualReplicas = await getCurrentReplicas(service);
          if (actualReplicas < targetReplicas) {
            logError(
              `[rolloutService] Only ${actualReplicas} containers started out of ${targetReplicas} requested`,
            );
            throw new Error(
              `[rolloutService] Failed to start all containers: only ${actualReplicas} started`,
            );
          }
        }
        throw error;
      }
    }

    logInfo(`[rolloutService] Rollout completed for service: ${service}`);
    logInfo(
      `[rolloutService] Exit: service=${service}, targetReplicas=${targetReplicas}`,
    );
  } catch (error) {
    logError(
      `[rolloutService] Error for service ${service}: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

// Function to handle one-off services
async function handleOneOffService(service: string): Promise<void> {
  logInfo(`Handling one-off service: ${service}`);

  try {
    // Check if the service is already running
    let currentReplicas = 0;
    try {
      currentReplicas = await getCurrentReplicas(service);
    } catch (error) {
      // If we can't get replicas (service never run), assume 0 replicas
      logInfo(
        `Could not determine current replicas for ${service}, assuming 0 (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    if (currentReplicas > 0) {
      logInfo(
        `