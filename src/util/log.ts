export const llog = (...args: unknown[]): void => {
  console.log(...args);
};

export const logError = (...args: unknown[]): void => {
  const error = new Error("dummy");
  // Capture the stack trace
  const stack = error.stack?.split("\n");
  if (stack && stack.length > 2 && stack[2]) {
    const [_, __, ...lines] = stack.map((line) => {
      return `${line.trim()}\n`;
    });

    const argsWithNewlines: unknown[] = [];
    for (let index = 0; index < args.length; index++) {
      argsWithNewlines.push(args[index]);
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
