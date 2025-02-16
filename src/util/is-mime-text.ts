export const isMimeText = (type: string) => {
  return (
    ["", "application/xml", "text/plain"].includes(type) ||
    type.includes("text")
  );
};
