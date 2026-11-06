// Control characters other than tab, line feed and carriage return.
const nonPrintablePattern = /[\u0000-\u0008\v\f\u000E-\u001F\u007F-\u009F]/u;

export const isPlainText = (testedString: string) =>
  !nonPrintablePattern.test(testedString);
