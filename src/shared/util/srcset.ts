const candidateSeparator = /\s*,\s+|(?<=\s[\d.]+[hwx]),\s*/u;

export const mapSrcset = (
  value: string,
  rewrite: (url: string) => string,
): string =>
  value
    .trim()
    .split(candidateSeparator)
    .filter(Boolean)
    .map((candidate) => {
      const [url, ...descriptors] = candidate.split(/\s+/u);
      return url ? [rewrite(url), ...descriptors].join(" ") : candidate;
    })
    .join(", ");
