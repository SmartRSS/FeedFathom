export function strictFake<T extends object>(
  implemented: Partial<T> = {},
  name = "fake",
): T {
  const fake = new Proxy(implemented, {
    get(target, key, receiver) {
      if (typeof key === "symbol" || key === "then" || key in target)
        return Reflect.get(target, key, receiver);
      throw new Error(`Unexpected dependency call: ${name}.${key}`);
    },
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return fake as T;
}
