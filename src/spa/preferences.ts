import { type Accessor, createSignal } from "solid-js";

export type Preference<T> = {
  get: Accessor<T>;
  reload(): void;
  set(value: T): void;
};

// Every preference is one localStorage key holding String(value), read once
// at load. Storage throws in a private-browsing context and when the origin
// has no storage access, so both directions fall back silently. Anything
// stored that is not one of `values` reads as the fallback. Toggles were
// stored as "on"/"off" before they were booleans, and still read as such.
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
  return {
    get,
    // Re-reads storage without writing it, for a change another tab made.
    reload: () => setSignal(() => read()),
    set(value: T) {
      setSignal(() => value);
      try {
        localStorage.setItem(key, String(value));
      } catch {}
    },
  };
}

export const storedToggle = (key: string, fallback: boolean) =>
  storedPreference(key, [true, false], fallback);

export const theme = storedPreference(
  "theme",
  ["auto", "smart", "classic", "millennial", "aero", "modern", "high-contrast"],
  "auto",
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
export const markReadPolicy = storedPreference(
  "markReadPolicy",
  ["manual", "on-open", "on-scroll-past"],
  legacyMarkReadPolicy(),
);

// The virtual "Today" view in the sidebar (#715). Opt-out rather than
// opt-in: it is one extra row, but pure source navigation is a legitimate
// preference and the maintainer wants the choice to exist.
export const todayView = storedToggle("todayView", true);

// The two search boxes: the sidebar's feed filter and the article list's
// search. Each is one row of a pane that has little vertical space to spare,
// and a reader with a dozen feeds needs neither, so both are opt-out. They
// are separate settings because they do different work -- the filter narrows
// what is already loaded, search asks the server -- and wanting one without
// the other is a reasonable position.
export const feedFilterBox = storedToggle("feedFilterBox", true);
export const articleSearchBox = storedToggle("articleSearchBox", true);

// Session restoration (#718). Opt-out rather than opt-in, per the issue:
// "reopening the app should feel like you never left" is the behaviour a
// reader expects, and the toggle exists for the people who always want to
// start at the top. Off means no snapshot is written and none is restored.
export const rememberReadingPosition = storedToggle(
  "rememberReadingPosition",
  true,
);

// On a phone the article list always fills the viewport, so a list shorter
// than one screen leaves a blank stretch under its last row. Bottom-anchoring
// the rows closes that gap; some readers prefer the list to simply end where
// its content ends, hence the toggle. It ships on: the blank stretch reads as
// unfinished, and the rows still scroll normally once the list overflows.
export const mobileListAnchor = storedToggle("mobileListAnchor", true);

// Reader typography (#712). Two axes, three steps each, rather than a free
// number: the defaults set in #719 are the middle step, and a slider would
// invite widths the measure argument exists to rule out. The steps land on
// the stylesheet as data attributes, the same way the theme does, so the
// values stay in CSS with the rules that use them.
const READER_STEPS = ["small", "medium", "large"] as const;
export const readerText = storedPreference(
  "readerText",
  READER_STEPS,
  "medium",
);
export const readerWidth = storedPreference(
  "readerWidth",
  READER_STEPS,
  "medium",
);

// Whether attachment blocks start expanded. "single" is the default, as in
// Smart-RSS: a lone attachment is usually the point of the article (an
// episode, a video), while a list of them is usually a gallery.
export const enclosuresOpen = storedPreference(
  "enclosuresOpen",
  ["always", "never", "single"],
  "single",
);

// A YouTube attachment plays in an embedded player. "click" is the default:
// until the reader asks, YouTube receives nothing but the thumbnail request.
// The cookieless host is the default for the same reason; the main host
// keeps the viewer's YouTube login (Premium, history) at the cost of letting
// YouTube follow them here.
export const youtubeLoad = storedPreference(
  "youtubeLoad",
  ["click", "open"],
  "click",
);
export const youtubeHost = storedPreference(
  "youtubeHost",
  ["nocookie", "youtube"],
  "nocookie",
);
