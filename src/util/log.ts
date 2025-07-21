function errorToString(e: unknown): string {
  if (e instanceof Error) return e.stack ?? e.message;
  if (typeof e === "object" && e !== null) return JSON.stringify(e);
  return String(e);
}

export const llog = (...args: unknown[]): void => {
  console.log(...args.map(errorToString));
};

export const logError = (...args: unknown[]): void => {
  const error = new Error("dummy");
  // Capture the stack trace
  const stack = error.stack?.split("\n");
  if (stack && stack.length > 2 && stack[2]) {
    const [_, __, ...lines] = stack.map((line) => {
      return `${line.trim()}\n`;
    });

    const argsWithNewlines: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg !== undefined) {
        argsWithNewlines.push(errorToString(arg));
      }
      if (index < args.length - 1) {
        argsWithNewlines.push("\n");
      }
    }

    const message = [
      `${new Date().toISOString()}\n`,
      ...lines,
      "Passed arguments: \n",
      ...argsWithNewlines,
    ];

    console.error(message.join(""));
  }
};
