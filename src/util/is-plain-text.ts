export function isPlainText(string_: string) {
  // This regular expression matches any character not typically found in plain text.
  // It allows space, tab, and printable ASCII characters.
  // This regular expression is intended to match control characters that wouldn't appear in plain text.
  // eslint-disable-next-line no-control-regex
  const nonPrintablePattern = /[\u0000-\u0008\v\f\u000E-\u001F\u007F-\u009F]/;
  return !nonPrintablePattern.test(string_);
}
