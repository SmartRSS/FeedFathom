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
  // biome-ignore lint/suspicious/noConsole: Logging is intentional
  // biome-ignore lint/suspicious/noConsoleLog: <explanation>
  console.log(message);
}

function logError(message: string): void {
  // biome-ignore lint/suspicious/noConsole: Error logging is intentional
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

    // Add debug logging
    logInfo(`Checking health for container ${containerId}:`);
    logInfo(`Container found: ${!!container}`);
    if (!container) {
      return false;
    }

    const containerHealth = container?.Health?.toLowerCase() || "";
    logInfo(`Container health: ${containerHealth}`);
    logInfo(`Container status: ${container.Status}`);

    // Handle "starting" health state or empty health (transitional state)
    if (containerHealth === "starting" || !containerHealth) {
      return false; // Container is still starting/transitioning, not healthy yet
    }

    // Only throw error if we're sure there's no health check (container is fully started)
    if (
      !containerHealth &&
      container.Status.includes("Up") &&
      !container.Status.includes("health")
    ) {
      throw new Error(
        `Container ${containerId} has no health check configured`,
      );
    }

    return containerHealth === expectedStatus.toLowerCase();
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("No such container")) {
      // If container doesn't exist, consider it unhealthy
      return false;
    }
    throw error;
  }
}

// Function to get containers sorted by age
async function getContainersByAge(
  service: string,
  count: number,
  ascending = true,
): Promise<string[]> {
  try {
    logInfo(
      `Getting containers for service ${service} (count: ${count}, ascending: ${ascending})`,
    );
    const result = await executeComposeCommand(`ps ${service} --format json`);

    const containers = parseJSONL<Container>(result, `service ${service}`);

    // Filter out non-running containers
    const runningContainers = containers.filter((c) => c.State === "running");
    logInfo(
      `Found ${runningContainers.length} running containers out of ${containers.length} total`,
    );

    if (runningContainers.length === 0) {
      logInfo("No running containers found");
      return [];
    }

    const sortedContainers = runningContainers
      .sort((a, b) => {
        // Parse the Docker date format: "2025-04-03 09:30:05 +0200 CEST"
        const parseDockerDate = (dateStr: string): number => {
          if (!dateStr) {
            throw new Error("Missing creation date");
          }
          // Replace first space with T, remove second space and everything after it
          const isoDate = dateStr.replace(" ", "T").split(" ")[0];
          // Ensure we have a valid string before creating a Date object
          if (!isoDate) {
            throw new Error(`Invalid date format: ${dateStr}`);
          }
          return new Date(isoDate).getTime();
        };

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

    const containerIds = sortedContainers.map((c) => c.ID);
    return containerIds;
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

// Function to wait for containers to be healthy
async function waitForContainerStatus(
  containers: string[],
  status: string,
  timeoutMs = 30000,
) {
  const existingContainers = [];
  const startTime = Date.now();

  // First filter out containers that no longer exist
  for (const container of containers) {
    try {
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
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("No such container")
      ) {
        logInfo(
          `Container ${container} no longer exists, skipping health check`,
        );
      } else {
        throw error;
      }
    }
  }

  if (existingContainers.length === 0) {
    logInfo("No running containers to check health status");
    return;
  }

  // Check initial status of all containers
  const unhealthyContainers = [];
  for (const container of existingContainers) {
    const isHealthy = await compareContainerStatus(container.ID, status);
    if (!isHealthy) {
      unhealthyContainers.push(container.ID);
    } else {
      logInfo(`Container ${container.ID} is already ${status}`);
    }
  }

  if (unhealthyContainers.length === 0) {
    logInfo("All containers are already healthy");
    return;
  }

  // Wait for remaining unhealthy containers to reach desired status
  for (const containerId of unhealthyContainers) {
    while (!(await compareContainerStatus(containerId, status))) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(
          `Timeout waiting for container ${containerId} to become ${status}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, healthcheckInterval));
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

  // Filter out containers that no longer exist
  const existingContainers = [];
  for (const containerId of containers) {
    try {
      const result = await executeComposeCommand("ps --format json");
      const containerInfo = parseJSONL<Container>(result, "container status");
      const container = containerInfo.find((c) => c.ID === containerId);

      if (container?.State === "running") {
        existingContainers.push(containerId);
      }
    } catch (error) {
      logInfo(
        `Error checking container ${containerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (existingContainers.length === 0) {
    logInfo("No running containers to drain");
    return;
  }

  // Create drain files only in existing containers
  for (const containerId of existingContainers) {
    try {
      await executeDockerCommand(`docker exec ${containerId} touch /tmp/drain`);
    } catch (error) {
      logError(
        `Failed to create drain file in container ${containerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}

async function gracefulShutdown(containers: string[]) {
  // Drain and stop the old containers
  await drainContainers(containers);
  await waitForContainerStatus(containers, "unhealthy");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await stopDrainedContainers(containers);
}

// Function to scale service
async function scaleService(service: string, replicas: number) {
  if (!Number.isInteger(replicas) || replicas < 0) {
    throw new Error("Replica count must be a non-negative integer");
  }
  logInfo(`Scaling service ${service} to ${replicas} replicas`);

  // Use up --scale instead of scale to add new containers without replacing existing ones
  await executeComposeCommand(
    `up -d --scale ${service}=${replicas} --no-recreate`,
  );

  // Wait a moment for containers to start
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const actualReplicas = await getCurrentReplicas(service);
  if (actualReplicas !== replicas) {
    throw new Error(
      `Failed to scale service ${service} to ${replicas} replicas (got ${actualReplicas})`,
    );
  }
}

// Helper function to stop drained containers
async function stopDrainedContainers(containers: string[]): Promise<void> {
  if (containers.length === 0) {
    logInfo("No containers to stop");
    return;
  }

  const containerIds = containers.join(" ");
  logInfo(`Stopping containers ${containerIds}`);

  try {
    await executeDockerCommand(`docker stop ${containerIds}`);
    logInfo(`Successfully stopped containers ${containerIds}`);
  } catch (error) {
    // If containers don't exist, that's fine - they're already stopped
    if (error instanceof Error && error.message.includes("No such container")) {
      logInfo(`Containers ${containerIds} no longer exist, skipping stop`);
    } else {
      throw error;
    }
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
      logInfo(`Service ${service} has no healthcheck, might be one-off`);
    }

    // Heuristic 2: If restart policy is "no", "on-failure", or not defined, it might be one-off
    if (
      serviceConfig.restart === "no" ||
      serviceConfig.restart === "on-failure" ||
      !serviceConfig.restart
    ) {
      logInfo(
        `Service ${service} has restart policy "${serviceConfig.restart}", might be one-off`,
      );
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
        logInfo(
          `Service ${service} has command that suggests one-off task: ${cmdStr}`,
        );
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

// Main rollout function
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <explanation>
async function rolloutService(service: string, targetReplicas: number) {
  logInfo(`Starting rollout for service: ${service}`);

  // Determine service type
  const serviceType = await getServiceType(service);

  if (serviceType === "one-off") {
    // Handle one-off service
    await handleOneOffService(service);
    return;
  }

  // Handle long-running service (existing logic)
  const step = calculateStep(targetReplicas);
  const initialReplicas = await getCurrentReplicas(service);

  logInfo(
    `Target replicas: ${targetReplicas}, Current replicas: ${initialReplicas}, Step size: ${step}`,
  );

  // Get all current containers
  const oldContainers = await getOldestContainers(service, initialReplicas);
  logInfo(`Identified ${oldContainers.length} old containers to be replaced`);

  // Phase 1: Scale down if we have more containers than target
  while (oldContainers.length > targetReplicas) {
    const scaleDelta = Math.min(step, oldContainers.length - targetReplicas);
    const toDrain = oldContainers.splice(0, scaleDelta);

    logInfo(`Phase 1: Scaling down by ${scaleDelta} containers`);
    await gracefulShutdown(toDrain);
  }

  // Phase 2: Replace remaining containers with new ones
  while (oldContainers.length > 0) {
    const scaleDelta = Math.min(step, oldContainers.length);
    // Scale up with new containers
    const upScale = targetReplicas + scaleDelta;
    logInfo(
      `Phase 2: Scaling up to ${upScale} replicas (adding ${scaleDelta} new containers)`,
    );

    await scaleService(service, upScale);

    // Get and wait for the new containers to be healthy
    const newContainers = await getLatestContainers(service, scaleDelta);
    logInfo(`New containers created: ${newContainers.join(" ")}`);

    try {
      logInfo(`Waiting for healthy containers ${newContainers.join(" ")}`);
      await waitForContainerStatus(newContainers, "healthy", 30000); // 30 second timeout
    } catch (error) {
      if (error instanceof Error && error.message.includes("Timeout")) {
        logError(
          `Timeout waiting for containers to become healthy: ${error.message}`,
        );
        // Get current replicas to see what actually started
        const currentReplicas = await getCurrentReplicas(service);
        if (currentReplicas < upScale) {
          logError(
            `Only ${currentReplicas} containers started out of ${upScale} requested`,
          );
          throw new Error(
            `Failed to start all containers: only ${currentReplicas} started`,
          );
        }
      }
      throw error;
    }

    // Only drain old containers after new ones are healthy
    const toDrain = oldContainers.splice(0, scaleDelta);
    logInfo(`Draining old containers: ${toDrain.join(" ")}`);
    await gracefulShutdown(toDrain);
  }

  // Final adjustment if needed
  const currentReplicas = await getCurrentReplicas(service);
  if (currentReplicas !== targetReplicas) {
    logInfo(`Final adjustment: scaling to ${targetReplicas} replicas`);
    await scaleService(service, targetReplicas);
    // Get and wait for the new containers to be healthy
    const newContainers = await getLatestContainers(
      service,
      targetReplicas - currentReplicas,
    );

    try {
      logInfo(`Waiting for healthy containers ${newContainers.join(" ")}`);
      await waitForContainerStatus(newContainers, "healthy", 30000); // 30 second timeout
    } catch (error) {
      if (error instanceof Error && error.message.includes("Timeout")) {
        logError(
          `Timeout waiting for containers to become healthy: ${error.message}`,
        );
        // Get current replicas to see what actually started
        const actualReplicas = await getCurrentReplicas(service);
        if (actualReplicas < targetReplicas) {
          logError(
            `Only ${actualReplicas} containers started out of ${targetReplicas} requested`,
          );
          throw new Error(
            `Failed to start all containers: only ${actualReplicas} started`,
          );
        }
      }
      throw error;
    }
  }

  logInfo(`Rollout completed for service: ${service}`);
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
        `Service ${service} is already running with ${currentReplicas} replicas. Stopping existing containers.`,
      );
      await executeDockerCommand(`docker stop ${service}`);
    }

    // Run the one-off service
    await runOneOffService(service);

    logInfo(`One-off service ${service} rollout completed`);
  } catch (error) {
    logError(
      `Failed to handle one-off service ${service}: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

// Function to check if the compose project is running
async function isComposeProjectRunning(): Promise<boolean> {
  try {
    const result = await executeComposeCommand("ps --format json");
    const containers = parseJSONL<Container>(result, "project status");
    return containers.length > 0;
  } catch (error) {
    logInfo(
      `Compose project appears to be not running: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function usage(code = 0) {
  logInfo(`
Usage: bun rollout.js [OPTIONS] SERVICE [SERVICE...]

Gradually roll out updates to specified services.

Options:
  -h, --help                  Print usage
  -f, --file FILE             Compose configuration files
  -v, --version               Print version
`);
  process.exit(code);
}

// Parse compose files and services
const services: string[] = [];
const args = process.argv.slice(2);

while (args.length > 0) {
  const arg = args.shift();
  switch (arg) {
    case "-h":
    case "--help":
      usage();
      break;
    case "-f":
    case "--file":
      if (args.length > 0) {
        const file = args.shift();
        if (file) {
          composeFiles.push(file);
        }
      }
      break;
    default:
      if (arg?.startsWith("-")) {
        logError(`Unknown option: ${arg}`);
        usage(1);
      } else if (arg) {
        services.push(arg);
      }
  }
}

// Require at least one service
if (services.length === 0) {
  logError("At least one SERVICE is required");
  usage();
  process.exit(1);
}

// Check if the compose project is running
const isRunning = await isComposeProjectRunning();

if (!isRunning) {
  logInfo(
    "Compose project is not running. Starting all services with 'docker compose up -d'",
  );
  try {
    await executeComposeCommand("up -d > /dev/null 2>&1");
    // Wait for all services to be healthy before proceeding
    logInfo("Waiting for all services to be healthy...");
    while (true) {
      try {
        const result = await executeComposeCommand("ps --format json");
        const containers = parseJSONL<Container>(result, "project status");
        const nonHealthyContainers = containers.filter(
          (container): container is Container => {
            if (container.State !== "running") {
              return false;
            }
            return (
              !container.Health || container.Health.toLowerCase() !== "healthy"
            );
          },
        );

        if (nonHealthyContainers.length === 0) {
          break;
        }

        logInfo(
          `Waiting for ${nonHealthyContainers.length} containers to become healthy...`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, healthcheckInterval),
        );
      } catch (error) {
        logError(
          `Error checking container health: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }

    logInfo("All services started successfully");
    process.exit(0);
  } catch (error) {
    logError(
      `Failed to start services: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

// Get target replicas for all services at once
const targetReplicasMap = await getTargetReplicasMap(services);

// Process each service
for (const service of services) {
  logInfo(`Processing service: ${service}`);
  const targetReplicas = targetReplicasMap.get(service);
  if (!targetReplicas) {
    logError(`Target replicas not found for service: ${service}`);
    process.exit(1);
  }
  await rolloutService(service, targetReplicas);
}
