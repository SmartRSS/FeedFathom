export const hostIs = (url: URL, domain: string): boolean =>
  url.hostname === domain || url.hostname.endsWith(`.${domain}`);
