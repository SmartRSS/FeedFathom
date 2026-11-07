// A candidate ends at a comma followed by whitespace or one right after its
// descriptor; a comma inside the URL itself, as in a data: URI, splits nothing.
const candidateSeparator = /\s*,\s+|(?<=\s[\d.]+[hwx]),\s*/u;

/** A srcset value with each candidate's URL passed through `rewrite`. */
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
