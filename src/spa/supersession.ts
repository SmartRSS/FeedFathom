export type SupersessionToken = number;

export function createSupersessionGuard() {
  let latest: SupersessionToken = 0;
  return {
    current: (): SupersessionToken => latest,
    isCurrent: (token: SupersessionToken) => token === latest,
    start: (): SupersessionToken => ++latest,
  };
}
