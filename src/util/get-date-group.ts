let boundaryMemory:
  | undefined
  | {
      [key: string]: {
        lastYear: Date;
        oneMonthAgo: Date;
        oneWeekAgo: Date;
        today: Date;
        twoMonthsAgo: Date;
      };
    };

export const generateBoundaryDates = () => {
  const now = new Date();

  // Today's boundary
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);

  // Last Week's boundary
  const oneWeekAgo = new Date(midnight);
  oneWeekAgo.setDate(midnight.getDate() - 7);
  oneWeekAgo.setHours(0, 0, 0, 0);

  // Last Month's boundary
  const oneMonthAgo = new Date(midnight);
  oneMonthAgo.setMonth(midnight.getMonth() - 1);
  oneMonthAgo.setHours(0, 0, 0, 0);

  // Two Months Ago boundary (for future use)
  const twoMonthsAgo = new Date(midnight);
  twoMonthsAgo.setMonth(midnight.getMonth() - 2);
  twoMonthsAgo.setHours(0, 0, 0, 0);

  // Last Year's boundary
  const lastYear = new Date(midnight);
  lastYear.setFullYear(midnight.getFullYear() - 1);
  lastYear.setHours(0, 0, 0, 0);

  return {
    lastYear,
    oneMonthAgo,
    oneWeekAgo,
    today: midnight,
    twoMonthsAgo,
  };
};

export const getBoundaryDates = () => {
  const today = new Date().getDate();
  if (boundaryMemory && today in boundaryMemory && boundaryMemory[today]) {
    return boundaryMemory[today];
  }

  const boundaryDates = generateBoundaryDates();
  boundaryMemory = {};
  boundaryMemory[today] = boundaryDates;
  return boundaryDates;
};

export const getDateGroup = (
  boundaryDates: ReturnType<typeof getBoundaryDates>,
  pubDate: Date,
) => {
  if (pubDate.toDateString() === boundaryDates.today.toDateString()) {
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
