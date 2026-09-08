import { createSignal } from "solid-js";

export type Theme =
  | "aero"
  | "auto"
  | "classic"
  | "high-contrast"
  | "millennial"
  | "modern"
  | "smart";
const THEMES: readonly Theme[] = [
  "auto",
  "smart",
  "classic",
  "millennial",
  "aero",
  "modern",
  "high-contrast",
];
const THEME_KEY = "theme";

export function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value);
}

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored && isTheme(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

const [theme, setThemeSignal] = createSignal<Theme>(readTheme());
export { theme };

export function setTheme(value: Theme) {
  setThemeSignal(value);
  try {
    localStorage.setItem(THEME_KEY, value);
  } catch {}
}

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
export function resolvedTheme(): Theme {
  const current = theme();
  if (current === "auto" && osHighContrast()) return "high-contrast";
  return current;
}

// When articles get marked read (#714). "manual" is the default on purpose:
// this app's workflow is delete-as-you-read, and marking anything behind the
// user's back would quietly empty the unread badge for someone who never
// asked for read state at all. The two automatic policies still exist because
// reasonable readers disagree strongly about this.
export type MarkReadPolicy = "manual" | "on-open" | "on-scroll-past";
const MARK_READ_POLICIES: readonly MarkReadPolicy[] = [
  "manual",
  "on-open",
  "on-scroll-past",
];
const MARK_READ_POLICY_KEY = "markReadPolicy";

export function isMarkReadPolicy(value: string): value is MarkReadPolicy {
  return (MARK_READ_POLICIES as readonly string[]).includes(value);
}
// Pre-#714 the only choice was a boolean stored under its own key; read it
// once as a fallback so an existing "on" survives the rename.
const MARK_READ_ON_OPEN_LEGACY_KEY = "markReadOnOpen";

export function parseMarkReadPolicy(
  stored: string | null,
  legacyStored: string | null,
): MarkReadPolicy {
  if (stored && isMarkReadPolicy(stored)) return stored;
  if (legacyStored === "true") return "on-open";
  return "manual";
}

function readMarkReadPolicy(): MarkReadPolicy {
  try {
    return parseMarkReadPolicy(
      localStorage.getItem(MARK_READ_POLICY_KEY),
      localStorage.getItem(MARK_READ_ON_OPEN_LEGACY_KEY),
    );
  } catch {
    return "manual";
  }
}

const [markReadPolicy, setMarkReadPolicySignal] =
  createSignal<MarkReadPolicy>(readMarkReadPolicy());
export { markReadPolicy };

export function setMarkReadPolicy(value: MarkReadPolicy) {
  setMarkReadPolicySignal(value);
  try {
    localStorage.setItem(MARK_READ_POLICY_KEY, value);
  } catch {}
}

// The virtual "Today" view in the sidebar (#715). Opt-out rather than
// opt-in: it is one extra row, but pure source navigation is a legitimate
// preference and the maintainer wants the choice to exist.
const TODAY_VIEW_KEY = "todayView";

export type OnOff = "off" | "on";
function isOnOff(value: string): value is OnOff {
  return value === "off" || value === "on";
}

function readTodayView(): OnOff {
  try {
    const stored = localStorage.getItem(TODAY_VIEW_KEY);
    return stored && isOnOff(stored) ? stored : "on";
  } catch {
    return "on";
  }
}

const [todayView, setTodayViewSignal] = createSignal<OnOff>(readTodayView());
export { todayView };

export function setTodayView(value: OnOff) {
  setTodayViewSignal(value);
  try {
    localStorage.setItem(TODAY_VIEW_KEY, value);
  } catch {}
}

// Session restoration (#718). Opt-out rather than opt-in, per the issue:
// "reopening the app should feel like you never left" is the behaviour a
// reader expects, and the toggle exists for the people who always want to
// start at the top. Off means no snapshot is written and none is restored.
const REMEMBER_READING_POSITION_KEY = "rememberReadingPosition";

export function parseRememberReadingPosition(stored: string | null): boolean {
  return stored !== "off";
}

function readRememberReadingPosition(): boolean {
  try {
    return parseRememberReadingPosition(
      localStorage.getItem(REMEMBER_READING_POSITION_KEY),
    );
  } catch {
    return true;
  }
}

const [rememberReadingPosition, setRememberReadingPositionSignal] =
  createSignal(readRememberReadingPosition());
export { rememberReadingPosition };

export function setRememberReadingPosition(value: boolean) {
  setRememberReadingPositionSignal(value);
  try {
    localStorage.setItem(REMEMBER_READING_POSITION_KEY, value ? "on" : "off");
  } catch {}
}

// Reader typography (#712). Two axes, three steps each, rather than a free
// number: the defaults set in #719 are the middle step, and a slider would
// invite widths the measure argument exists to rule out. The steps land on
// the stylesheet as data attributes, the same way the theme does, so the
// values stay in CSS with the rules that use them.
const READER_TEXT_KEY = "readerText";
const READER_WIDTH_KEY = "readerWidth";

export type ReaderStep = "large" | "medium" | "small";
const READER_STEPS: readonly ReaderStep[] = ["small", "medium", "large"];

export function isReaderStep(value: string): value is ReaderStep {
  return (READER_STEPS as readonly string[]).includes(value);
}

function readStep(key: string): ReaderStep {
  try {
    const stored = localStorage.getItem(key);
    return stored && isReaderStep(stored) ? stored : "medium";
  } catch {
    return "medium";
  }
}

const [readerText, setReaderTextSignal] = createSignal<ReaderStep>(
  readStep(READER_TEXT_KEY),
);
export { readerText };

export function setReaderText(value: ReaderStep) {
  setReaderTextSignal(value);
  try {
    localStorage.setItem(READER_TEXT_KEY, value);
  } catch {}
}

const [readerWidth, setReaderWidthSignal] = createSignal<ReaderStep>(
  readStep(READER_WIDTH_KEY),
);
export { readerWidth };

export function setReaderWidth(value: ReaderStep) {
  setReaderWidthSignal(value);
  try {
    localStorage.setItem(READER_WIDTH_KEY, value);
  } catch {}
}
