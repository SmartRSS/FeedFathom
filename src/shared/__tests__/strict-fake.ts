// A test double typed as the whole dependency that implements only what the
// test hands it. Reading any other member throws and names it, so a handler
// that starts using something the test never arranged fails loudly instead
// of receiving undefined. Symbols and `then` read through: `await`, `expect`
// and the console probe for them on any value.
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
  // The proxy is what makes the missing members of Partial<T> unreachable.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return fake as T;
}
