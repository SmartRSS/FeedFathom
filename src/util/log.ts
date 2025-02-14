/* eslint-disable no-console */
export const llog = (...args: unknown[]): void => {
  console.log(new Date().toISOString(), ...args);
};

export const logError = (...args: unknown[]): void => {
  const error = new Error("dummy");
  // Capture the stack trace
  const stack = error.stack?.split("\n");
  if (stack && stack.length > 2 && stack[2]) {
    // The third line of the stack trace should indicate the caller location
    const callerLine = stack[2].trim();
    console.error(new Date().toISOString(), callerLine, ...args);
    return;
  }

  console.error(new Date().toISOString(), ...args);
};
