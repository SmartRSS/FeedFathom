import { createSignal } from "solid-js";

const HIGH_CONTRAST_KEY = "high-contrast";

function readHighContrast(): boolean {
  try {
    return localStorage.getItem(HIGH_CONTRAST_KEY) === "true";
  } catch {
    return false;
  }
}

const [highContrast, setHighContrastSignal] = createSignal(readHighContrast());
export { highContrast };

export function setHighContrast(value: boolean) {
  setHighContrastSignal(value);
  try {
    localStorage.setItem(HIGH_CONTRAST_KEY, value ? "true" : "false");
  } catch {}
}
