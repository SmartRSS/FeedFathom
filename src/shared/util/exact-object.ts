export const hasExactKeys = <Key extends string>(
  value: unknown,
  keys: readonly Key[],
): value is Record<Key, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  for (const key of keys) {
    if (!(key in value)) {
      return false;
    }
  }
  const allowed: readonly string[] = keys;
  return Object.getOwnPropertyNames(value).every((name) =>
    allowed.includes(name),
  );
};

export const isOneOf = <Option extends string>(
  value: unknown,
  options: readonly Option[],
): value is Option => {
  const allowed: readonly unknown[] = options;
  return allowed.includes(value);
};
