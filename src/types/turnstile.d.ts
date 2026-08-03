export interface Turnstile {
  render(
    container: string | HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
    },
  ): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}
