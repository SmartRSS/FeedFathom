// The toolbar badge is the only hint, short of opening the popup, that the
// content script found feeds on the current page. The colour is the icon's
// own orange (src/spa/assets/*-inverted-round.png), so the badge reads as
// part of the button rather than a notification pasted onto it.
export const badgeColor = "#ff7f00";

// Chrome clips badge text to about four characters and Firefox to fewer;
// "99+" is the conventional ceiling. Zero feeds clears the badge entirely --
// an inert-looking button is honest when there is nothing to subscribe to.
export const formatBadgeCount = (count: number): string => {
  if (!Number.isFinite(count) || count <= 0) return "";
  if (count > 99) return "99+";
  return String(count);
};
