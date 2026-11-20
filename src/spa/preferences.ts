import { type Accessor, createSignal, getOwner, onCleanup } from "solid-js";

export type Preference<T> = {
  get: Accessor<T>;
  set(value: T): void;
};

export type Setting<T> = Preference<T> & {
  choices: readonly (readonly [value: T, label: string])[];
};

export function storedPreference<const T extends boolean | string>(
  key: string,
  values: readonly T[],
  fallback: T,
): Preference<T>;
export function storedPreference(
  key: string,
  values: readonly (boolean | string)[],
  fallback: boolean | string,
): Preference<boolean | string> {
  const read = () => {
    try {
      const stored = localStorage.getItem(key);
      const migrated =
        stored === "on" ? "true" : stored === "off" ? "false" : stored;
      return values.find((value) => String(value) === migrated) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const [get, setSignal] = createSignal(read());
  const follow = (event: StorageEvent) => {
    if (event.key === key || event.key === null) setSignal(() => read());
  };
  if (typeof window === "object") {
    window.addEventListener("storage", follow);
    if (getOwner())
      onCleanup(() => window.removeEventListener("storage", follow));
  }
  return {
    get,
    set(value) {
      setSignal(() => value);
      try {
        localStorage.setItem(key, String(value));
      } catch {}
    },
  };
}

function storedSetting<const T extends boolean | string>(
  key: string,
  choices: Setting<T>["choices"],
  fallback: T,
): Setting<T> {
  const values = choices.map(([value]) => value);
  return { ...storedPreference(key, values, fallback), choices };
}

function storedToggle(key: string, fallback: boolean): Preference<boolean> {
  return storedPreference(key, [true, false], fallback);
}

export const theme = storedSetting(
  "theme",
  [
    ["auto", "Auto (follows your system)"],
    ["smart", "Smart"],
    ["classic", "Classic"],
    ["millennial", "Millennial"],
    ["aero", "Aero"],
    ["modern", "Modern"],
    ["high-contrast", "High contrast"],
  ],
  "auto",
);

export const density = storedSetting(
  "density",
  [
    ["comfortable", "Comfortable"],
    ["compact", "Compact"],
  ],
  "comfortable",
);

function prefersHighContrast(): boolean {
  if (typeof matchMedia !== "function") return false;
  try {
    return (
      matchMedia("(forced-colors: active)").matches ||
      matchMedia("(prefers-contrast: more)").matches
    );
  } catch {
    return false;
  }
}

const [osHighContrast, setOsHighContrast] = createSignal(prefersHighContrast());
if (typeof matchMedia === "function") {
  const update = () => setOsHighContrast(prefersHighContrast());
  for (const query of ["(forced-colors: active)", "(prefers-contrast: more)"]) {
    try {
      matchMedia(query).addEventListener("change", update);
    } catch {}
  }
}

export function resolvedTheme() {
  const current = theme.get();
  if (current === "auto" && osHighContrast()) return "high-contrast";
  return current;
}

function legacyMarkReadPolicy() {
  try {
    return localStorage.getItem("markReadOnOpen") === "true"
      ? "on-open"
      : "manual";
  } catch {
    return "manual";
  }
}
export const markReadPolicy = storedSetting(
  "markReadPolicy",
  [
    ["manual", "Manually (M key or Mark read)"],
    ["on-open", "On open (in the All view)"],
    ["on-scroll-past", "On scroll-past (after a second in view)"],
  ],
  legacyMarkReadPolicy(),
);

export const todayView = storedToggle("todayView", true);

export const feedFilterBox = storedToggle("feedFilterBox", true);
export const articleSearchBox = storedToggle("articleSearchBox", true);

export const rememberReadingPosition = storedToggle(
  "rememberReadingPosition",
  true,
);

export const mobileListAnchor = storedSetting(
  "mobileListAnchor",
  [
    [true, "At the bottom"],
    [false, "At the top"],
  ],
  true,
);

export const readerText = storedSetting(
  "readerText",
  [
    ["small", "Small"],
    ["medium", "Medium"],
    ["large", "Large"],
  ],
  "medium",
);
export const readerWidth = storedSetting(
  "readerWidth",
  [
    ["small", "Narrow"],
    ["medium", "Medium"],
    ["large", "Wide"],
  ],
  "medium",
);

export const enclosuresOpen = storedSetting(
  "enclosuresOpen",
  [
    ["single", "When there is only one"],
    ["always", "Always"],
    ["never", "Never"],
  ],
  "single",
);

export const youtubeLoad = storedSetting(
  "youtubeLoad",
  [
    ["click", "When you click them"],
    ["open", "When the article opens"],
  ],
  "click",
);
export const youtubeHost = storedSetting(
  "youtubeHost",
  [
    ["nocookie", "youtube-nocookie.com (signed out)"],
    ["youtube", "youtube.com (keeps your sign-in)"],
  ],
  "nocookie",
);

export const prefetchNext = storedToggle("prefetchNext", false);

export const offlineUnread = storedToggle("offlineUnread", false);

export const unreadBadge = storedToggle("unreadBadge", true);
export const backgroundPoll = storedToggle("backgroundPoll", true);

export const dateFormat = storedSetting(
  "dateFormat",
  [
    ["locale", "Your system's format"],
    ["iso", "ISO 8601 (UTC)"],
  ],
  "locale",
);
