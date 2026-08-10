import { createSignal } from "solid-js";

export type Theme =
  | "high-contrast"
  | "modern"
  | "win8plus"
  | "win95"
  | "winvista7"
  | "winxp";
const THEMES: readonly Theme[] = [
  "modern",
  "win95",
  "winxp",
  "winvista7",
  "win8plus",
  "high-contrast",
];
const THEME_KEY = "theme";

export function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value);
}

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored && isTheme(stored) ? stored : "modern";
  } catch {
    return "modern";
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
