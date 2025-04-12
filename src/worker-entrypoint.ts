import container from "./container.ts";
import { logError } from "./util/log.ts";

try {
  const initializer = container.resolve("initializer");
  await initializer.initialize();
} catch (error) {
  logError("Failed to initialize worker:", error);
  throw new Error("Worker initialization failed");
}
