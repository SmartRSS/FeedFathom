export const badgeColor = "#ff7f00";

export const formatBadgeCount = (count: number): string => {
  if (!Number.isFinite(count) || count <= 0) return "";
  if (count > 99) return "99+";
  return String(count);
};
