import { type Accessor, createSignal, getOwner, onCleanup } from "solid-js";

export type Preference<T> = {
  get: Accessor<T>;
  set(value: T): void;
};

// A preference the Options page offers, with the label of each value.
export type Setting<T> = Preference<T> & {
  choices: readonly (readonly [value: T, label: string])[];
};

// Every preference is one localStorage key holding String(value), read at
// load and again whenever another tab writes it. Storage throws in a
// private-browsing context and when the origin has no storage access, so both
// directions fall back silently. Anything stored that is not one of `values`
// reads as the fallback. Toggles were stored as "on"/"off" before they were
// booleans, and still read as such.
export function storedPreference<const T extends boolean | string>(
  key: string,
  values: readonly T[],
  fallback: T,
): Preference<T> {
  const read = (): T => {
    try {
      const stored = localStorage.getItem(key);
      const migrated =
        stored === "on" ? "true" : stored === "off" ? "false" : stored;
      return values.find((value) => String(value) === migrated) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const [get, setSignal] = createSignal<T>(read());
  // A null key means another tab cleared the whole storage.
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
    set(value: T) {
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

const SHOW_HIDE = [
  [true, "Show"],
  [false, "Hide"],
] as const;

const ON_OFF = [
  [true, "On"],
  [false, "Off"],
] as const;

// Each value has a block of its own in style.css.
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

// How much space the chrome takes, separate from the theme: "compact" halves
// the spacing scale and drops rows to 20px with the browser's line height.
// Stored per device like every preference, so a phone and a desktop can
// differ.
export const density = storedSetting(
  "density",
  [
    ["comfortable", "Comfortable"],
    ["compact", "Compact"],
  ],
  "comfortable",
);

// The only OS-level signal a webpage can actually read here: browsers
// don't expose which desktop theme or OS version is running (and
// User-Agent sniffing for that is both unreliable and being actively
// phased out), but "the user has an accessibility high-contrast/more-
// contrast preference turned on at the OS level" genuinely is exposed,
// via forced-colors (fires for Windows High Contrast Mode specifically)
// and the more general prefers-contrast media feature.
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

// What actually drives the app's [data-theme] attribute. "auto" normally
// passes straight through -- its own CSS block (see style.css) reads the
// browser's live system-color keywords (Highlight/AccentColor) so the
// selection color actually is whatever the OS's current accent color is,
// not a value this code chooses -- but switches to the app's own
// (contrast-verified) high-contrast theme when the OS signal above says
// the user needs that instead. Every other value is already concrete and
// passes through unconditionally.
export function resolvedTheme() {
  const current = theme.get();
  if (current === "auto" && osHighContrast()) return "high-contrast";
  return current;
}

// When articles get marked read (#714). "manual" is the default on purpose:
// this app's workflow is delete-as-you-read, and marking anything behind the
// user's back would quietly empty the unread badge for someone who never
// asked for read state at all. The two automatic policies still exist because
// reasonable readers disagree strongly about this.
//
// Pre-#714 the only choice was a boolean stored under its own key; it is the
// fallback, so an existing "true" survives the rename.
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

// The virtual "Today" view in the sidebar (#715). Opt-out rather than
// opt-in: it is one extra row, but pure source navigation is a legitimate
// preference and the maintainer wants the choice to exist.
export const todayView = storedSetting("todayView", SHOW_HIDE, true);

// The two search boxes: the sidebar's feed filter and the article list's
// search. Each is one row of a pane that has little vertical space to spare,
// and a reader with a dozen feeds needs neither, so both are opt-out. They
// are separate settings because they do different work -- the filter narrows
// what is already loaded, search asks the server -- and wanting one without
// the other is a reasonable position.
export const feedFilterBox = storedSetting("feedFilterBox", SHOW_HIDE, true);
export const articleSearchBox = storedSetting(
  "articleSearchBox",
  SHOW_HIDE,
  true,
);

// Session restoration (#718). Opt-out rather than opt-in, per the issue:
// "reopening the app should feel like you never left" is the behaviour a
// reader expects, and the toggle exists for the people who always want to
// start at the top. Off means no snapshot is written and none is restored.
export const rememberReadingPosition = storedSetting(
  "rememberReadingPosition",
  [
    [true, "On"],
    [false, "Off (always start at the top)"],
  ],
  true,
);

// On a phone the article list always fills the viewport, so a list shorter
// than one screen leaves a blank stretch under its last row. Bottom-anchoring
// the rows closes that gap; some readers prefer the list to simply end where
// its content ends, hence the toggle. It ships on: the blank stretch reads as
// unfinished, and the rows still scroll normally once the list overflows.
export const mobileListAnchor = storedSetting(
  "mobileListAnchor",
  [
    [true, "At the bottom"],
    [false, "At the top"],
  ],
  true,
);

// Reader typography (#712). Two axes, three steps each, rather than a free
// number: the defaults set in #719 are the middle step, and a slider would
// invite widths the measure argument exists to rule out. The steps land on
// the stylesheet as data attributes, the same way the theme does, so the
// values stay in CSS with the rules that use them.
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

// Whether attachment blocks start expanded. "single" is the default, as in
// Smart-RSS: a lone attachment is usually the point of the article (an
// episode, a video), while a list of them is usually a gallery.
export const enclosuresOpen = storedSetting(
  "enclosuresOpen",
  [
    ["single", "When there is only one"],
    ["always", "Always"],
    ["never", "Never"],
  ],
  "single",
);

// A YouTube attachment plays in an embedded player. "click" is the default:
// until the reader asks, YouTube receives nothing but the thumbnail request.
// The cookieless host is the default for the same reason; the main host
// keeps the viewer's YouTube login (Premium, history) at the cost of letting
// YouTube follow them here.
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

// Prefetching the next article's content (#716) costs the server one extra
// extract-route hit per opened article, and some users count that as waste:
// so this is off until it is switched on.
export const prefetchNext = storedSetting("prefetchNext", ON_OFF, false);

// Offline reading (#992) downloads every recent unread body, a far larger
// bill than one prefetch, so it is off until switched on too.
export const offlineUnread = storedSetting("offlineUnread", ON_OFF, false);

// The new-article signal (#717), two toggles kept independent on purpose: a
// badge is free, but background polling costs server load, and an operator
// who wants zero background traffic can turn that off without losing the
// tab-title count.
export const unreadBadge = storedSetting("unreadBadge", SHOW_HIDE, true);
export const backgroundPoll = storedSetting("backgroundPoll", ON_OFF, true);

// How timestamps render across the app (format-date.ts). "locale" is the
// user's own locale and timezone via Intl; "iso" is fixed UTC
// YYYY-MM-DD HH:mm for people who want unambiguous machine-style dates.
export const dateFormat = storedSetting(
  "dateFormat",
  [
    ["locale", "Your system's format"],
    ["iso", "ISO 8601 (UTC)"],
  ],
  "locale",
);
