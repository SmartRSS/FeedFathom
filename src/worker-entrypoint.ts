import container from "./container";

const initializer = container.resolve("initializer");

await initializer.initialize();
