// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally contains non-printable characters to exclude them
const nonPrintablePattern = /[\u0000-\u0008\v\f\u000E-\u001F\u007F-\u009F]/u;
export const isPlainText = (testedString: string) => {
  // This regular expression matches any character not typically found in plain text.
  // It allows space, tab, and printable ASCII characters.
  // This regular expression is intended to match control characters that wouldn't appear in plain text.

  return !nonPrintablePattern.test(testedString);
};
