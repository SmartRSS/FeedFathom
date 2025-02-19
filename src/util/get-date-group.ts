type BoundaryDates = {
  lastYear: Date;
  oneMonthAgo: Date;
  oneWeekAgo: Date;
  today: Date;
  twoMonthsAgo: Date;
};

let boundaryMemory:
  | undefined
  | {
      [key: string]: BoundaryDates;
    };

export const generateBoundaryDates = (): BoundaryDates => {
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
    lastYear,
    oneMonthAgo,
    oneWeekAgo,
    today: midnight,
    twoMonthsAgo,
  };
};

const getDateKey = (date: Date): string => {
  const [dateString] = date.toISOString().split('T');
  if (!dateString) {
    throw new Error('Failed to generate date key');
  }

  return dateString;
};

export const cleanupOldEntries = (): void => {
  if (!boundaryMemory) {
    return;
  }

  const todayKey = getDateKey(new Date());
  const currentValue = boundaryMemory[todayKey];
  if (!currentValue) {
    return;
  }

  const newMemory: { [key: string]: BoundaryDates } = {};
  newMemory[todayKey] = currentValue;
  boundaryMemory = newMemory;
};

export const getBoundaryDates = (): BoundaryDates => {
  const todayKey = getDateKey(new Date());

  if (boundaryMemory && todayKey in boundaryMemory && boundaryMemory[todayKey]) {
    return boundaryMemory[todayKey];
  }

  const boundaryDates = generateBoundaryDates();
  boundaryMemory = {};
  boundaryMemory[todayKey] = boundaryDates;
  cleanupOldEntries();
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
