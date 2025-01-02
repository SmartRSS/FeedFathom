export function isPlainText(str: string) {
  // This regular expression matches any character not typically found in plain text.
  // It allows space, tab, and printable ASCII characters.
  // This regular expression is intended to match control characters that wouldn't appear in plain text.
  // eslint-disable-next-line no-control-regex
  const nonPrintablePattern = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;
  return !nonPrintablePattern.test(str);
}
