import { $ } from "bun";

const VERSION = "v0.1.0";

// Check if compose v2 is available
const composeCommand = await $`which docker compose`.then(() => "docker compose").catch(() => "docker-compose");

// Function to get target replicas for all services from compose config
async function getTargetReplicasMap(services, composeFiles) {
    console.log(`Executing: ${composeCommand} ${composeFiles.join(" ")} config --format json`);
    const fullConfig = await $`${composeCommand} ${composeFiles} config --format json`;
    const config = JSON.parse(fullConfig.stdout);

    const replicasMap = new Map();

    for (const service of services) {
        const serviceConfig = config.services[service];
        if (!serviceConfig) {
            console.error(`Service ${service} not found in compose config`);
            process.exit(1);
        }
        replicasMap.set(service, serviceConfig.deploy?.replicas || 1);
    }

    return replicasMap;
}

// Function to calculate step size (10% of target replicas, rounded up)
function calculateStep(target) {
    return Math.ceil(target / 10);
}

// Function to get current number of replicas
async function getCurrentReplicas(service, composeFiles) {
    console.log(`Executing: ${composeCommand} ${composeFiles.join(" ")} ps -q ${service} | wc -l`);
    const result = await $`${composeCommand} ${composeFiles} ps -q ${service} | wc -l`;
    return parseInt(result.stdout);
}

// Function to check if container is healthy
async function isContainerHealthy(containerId) {
    console.log(`Executing: docker inspect --format='{{.State.Health.Status}}' ${containerId}`);
    const result = await $`docker inspect --format='{{.State.Health.Status}}' ${containerId}`;
    return result.stdout.trim() === "healthy";
}

// Function to get oldest containers
async function getOldestContainers(service, count, composeFiles) {
    console.log(`Executing: ${composeCommand} ${composeFiles.join(" ")} ps -q ${service} | xargs -I {} docker inspect --format='{{.Id}} {{.Created}}' {} | sort -k2 | head -n ${count} | cut -d' ' -f1`);
    const result = await $`${composeCommand} ${composeFiles} ps -q ${service} | xargs -I {} docker inspect --format='{{.Id}} {{.Created}}' {} | sort -k2 | head -n ${count} | cut -d' ' -f1`;
    return result.stdout.trim().split("\n");
}

// Main rollout function
async function rolloutService(service, composeFiles, targetReplicas) {
    console.log(`Starting rollout for service: ${service}`);

    // Calculate step size
    const step = calculateStep(targetReplicas);
    let currentReplicas = await getCurrentReplicas(service, composeFiles);

    console.log(`Target replicas: ${targetReplicas}, Current replicas: ${currentReplicas}, Step size: ${step}`);

    if (currentReplicas > targetReplicas) {
        // Scale down scenario
        let current = currentReplicas;
        while (current > targetReplicas) {
            const scaleDown = Math.min(step, current - targetReplicas);
            const oldestContainers = await getOldestContainers(service, scaleDown, composeFiles);

            // Drain oldest containers
            for (const container of oldestContainers) {
                console.log(`Executing: docker exec ${container} touch /tmp/drain`);
                await $`docker exec ${container} touch /tmp/drain`;
            }

            await new Promise(resolve => setTimeout(resolve, 30000));

            // Scale down
            console.log(`Executing: ${composeCommand} ${composeFiles.join(" ")} up -d --scale ${service}=${current - scaleDown}`);
            await $`${composeCommand} ${composeFiles} up -d --scale ${service}=${current - scaleDown}`;
            current -= scaleDown;
            console.log(`Scaled down to ${current} replicas`);
        }
    } else if (currentReplicas < targetReplicas) {
        // Scale up scenario
        let current = currentReplicas;
        while (current < targetReplicas) {
            const scaleUp = Math.min(step, targetReplicas - current);

            // Scale up
            console.log(`Executing: ${composeCommand} ${composeFiles.join(" ")} up -d --scale ${service}=${current + scaleUp}`);
            await $`${composeCommand} ${composeFiles} up -d --scale ${service}=${current + scaleUp}`;

            // Wait for new containers to be healthy
            console.log(`Executing: ${composeCommand} ${composeFiles.join(" ")} ps -q ${service} | tail -n ${scaleUp}`);
            const newContainers = (await $`${composeCommand} ${composeFiles} ps -q ${service} | tail -n ${scaleUp}`).stdout.trim().split("\n");

            for (const container of newContainers) {
                while (!(await isContainerHealthy(container))) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }

            current += scaleUp;
            console.log(`Scaled up to ${current} replicas`);
        }
    }

    // Handle any remaining old containers
    let oldContainers = await getOldestContainers(service, currentReplicas, composeFiles);
    while (oldContainers.length > 0) {
        const drainCount = Math.min(step, currentReplicas);
        const toDrain = oldContainers.slice(0, drainCount);

        // Drain containers
        for (const container of toDrain) {
            console.log(`Executing: docker exec ${container} touch /tmp/drain`);
            await $`docker exec ${container} touch /tmp/drain`;
        }

        await new Promise(resolve => setTimeout(resolve, 30000));

        // Scale down
        console.log(`Executing: ${composeCommand} ${composeFiles.join(" ")} up -d --scale ${service}=${currentReplicas - drainCount}`);
        await $`${composeCommand} ${composeFiles} up -d --scale ${service}=${currentReplicas - drainCount}`;
        currentReplicas -= drainCount;

        await new Promise(resolve => setTimeout(resolve, 10000));

        // Scale back up if needed
        if (currentReplicas < targetReplicas) {
            console.log(`Executing: ${composeCommand} ${composeFiles.join(" ")} up -d --scale ${service}=${targetReplicas}`);
            await $`${composeCommand} ${composeFiles} up -d --scale ${service}=${targetReplicas}`;

            // Wait for new containers to be healthy
            console.log(`Executing: ${composeCommand} ${composeFiles.join(" ")} ps -q ${service} | tail -n ${targetReplicas - currentReplicas}`);
            const newContainers = (await $`${composeCommand} ${composeFiles} ps -q ${service} | tail -n ${targetReplicas - currentReplicas}`).stdout.trim().split("\n");

            for (const container of newContainers) {
                while (!(await isContainerHealthy(container))) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }

            currentReplicas = targetReplicas;
        }

        // Update old containers list
        oldContainers = await getOldestContainers(service, currentReplicas, composeFiles);
    }

    // Final check to ensure we have the correct number of replicas
    if (await getCurrentReplicas(service, composeFiles) !== targetReplicas) {
        console.log(`Executing: ${composeCommand} ${composeFiles.join(" ")} up -d --scale ${service}=${targetReplicas}`);
        await $`${composeCommand} ${composeFiles} up -d --scale ${service}=${targetReplicas}`;
    }

    console.log(`Rollout completed for service: ${service}`);
}

function usage() {
    console.log(`
Usage: bun rollout.js [OPTIONS] SERVICE [SERVICE...]

Gradually roll out updates to specified services.

Options:
  -h, --help                  Print usage
  -f, --file FILE             Compose configuration files
  -v, --version               Print version
`);
}

// Parse compose files and services
const composeFiles = [];
const services = [];
const args = process.argv.slice(2);

while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
        case "-h":
        case "--help":
            usage();
            process.exit(0);
            break;
        case "-f":
        case "--file":
            if (args.length > 0) {
                composeFiles.push("-f", args.shift());
            }
            break;
        case "-v":
        case "--version":
            console.log(`rollout version ${VERSION}`);
            process.exit(0);
            break;
        default:
            if (arg.startsWith("-")) {
                console.error(`Unknown option: ${arg}`);
                usage();
                process.exit(1);
            } else {
                services.push(arg);
            }
    }
}

// Require at least one service
if (services.length === 0) {
    console.error("At least one SERVICE is required");
    usage();
    process.exit(1);
}

// Get target replicas for all services at once
const targetReplicasMap = await getTargetReplicasMap(services, composeFiles);

// Process each service
for (const service of services) {
    console.log(`Processing service: ${service}`);
    await rolloutService(service, composeFiles, targetReplicasMap.get(service));
}
