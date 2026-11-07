// True when the URL's host is `domain` or one of its subdomains. A bare
// suffix test would also accept evilhive.blog for hive.blog.
export const hostIs = (url: URL, domain: string): boolean =>
  url.hostname === domain || url.hostname.endsWith(`.${domain}`);
