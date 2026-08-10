import { createSignal } from "solid-js";

export type Theme =
  | "aero"
  | "classic"
  | "high-contrast"
  | "millennial"
  | "modern"
  | "smart";
const THEMES: readonly Theme[] = [
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
    return stored && isTheme(stored) ? stored : "smart";
  } catch {
    return "smart";
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
