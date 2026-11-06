export const generateBoundaryDates = (now = new Date()) => {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const oneWeekAgo = new Date(today);
  oneWeekAgo.setDate(today.getDate() - 7);

  const oneMonthAgo = new Date(today);
  oneMonthAgo.setMonth(today.getMonth() - 1);

  const lastYear = new Date(today);
  lastYear.setFullYear(today.getFullYear() - 1);

  return { lastYear, oneMonthAgo, oneWeekAgo, today };
};

export const getDateGroup = (
  boundaryDates: ReturnType<typeof generateBoundaryDates>,
  pubDate: Date,
) => {
  // Anything from the start of today on, later dates included: an article
  // dated ahead of the clock (skew, a publisher's time zone) belongs with
  // the newest, not in a second "Within the Last Week" above Today.
  if (pubDate >= boundaryDates.today) {
    return "Today";
  }

  if (pubDate >= boundaryDates.oneWeekAgo) {
    return "Within the Last Week";
  }

  if (pubDate >= boundaryDates.oneMonthAgo) {
    return "Within the Last Month";
  }

  if (pubDate >= boundaryDates.lastYear) {
    return "Within the Last Year";
  }

  return "Older";
};
