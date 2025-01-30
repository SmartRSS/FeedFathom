let boundaryMemory:
  | {
      [key: string]: {
        today: Date;
        oneWeekAgo: Date;
        oneMonthAgo: Date;
        twoMonthsAgo: Date;
        lastYear: Date;
      };
    }
  | undefined;

export const generateBoundaryDates = () => {
  const now = new Date();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(now.getDate() - 7);
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(now.getMonth() - 1);
  const twoMonthsAgo = new Date();
  twoMonthsAgo.setMonth(now.getMonth() - 2);
  const lastYear = new Date();
  lastYear.setFullYear(now.getFullYear() - 1);
  return {
    today: midnight,
    oneWeekAgo,
    oneMonthAgo,
    twoMonthsAgo,
    lastYear,
  };
};

export const getBoundaryDates = () => {
  const today = new Date().getDate();
  if (boundaryMemory && today in boundaryMemory) {
    return boundaryMemory[today]!;
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
