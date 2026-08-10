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
