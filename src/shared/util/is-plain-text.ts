const nonPrintablePattern = /[\u0000-\u0008\v\f\u000E-\u001F\u007F-\u009F]/u;
export const isPlainText = (testedString: string) => {
  // Reject control characters except tabs, line feeds and carriage returns.

  return !nonPrintablePattern.test(testedString);
};
