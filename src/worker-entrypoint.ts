import { container } from "./container.ts";
import { llog, logError } from "./util/log.ts";

try {
  llog("Starting worker entrypoint");
  const initializer = container.resolve("initializer");
  await initializer.initialize();
  llog("Worker initialized successfully");
} catch (error) {
  logError("Failed to initialize worker:", error);
  throw new Error("Worker initialization failed");
}
