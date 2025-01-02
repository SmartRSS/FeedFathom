export function isMimeText(type: string) {
  return (
    ["", "text/plain", "application/xml"].includes(type) ||
    type.includes("text")
  );
}
