// Session rows need a name a person recognises, not the raw User-Agent
// header: the tokens that identify a browser arrive in different orders and
// aliases (CriOS, Edg, SamsungBrowser), so the checks run most-specific
// first. iOS Safari masquerades as desktop Mac, and Android masquerades as
// Linux -- both platform checks precede the desktop ones they impersonate.
//
// Deliberately no dependency and no exhaustive database: a format this
// parser does not know falls back to the raw header, and blank/UNKNOWN rows
// written before the header was captured render as "Unknown device".

type Token = { pattern: RegExp; browser: string };

// Major version only: "Chrome/141.0.0.0" reads better as "Chrome 141".
const BROWSER_TOKENS: readonly Token[] = [
  { browser: "Samsung Internet", pattern: /SamsungBrowser\/(\d+)/u },
  { browser: "Edge", pattern: /Edg(?:e|A|iOS)?\/(\d+)/u },
  { browser: "Opera", pattern: /(?:OPR|Opera)[ /](\d+)/u },
  { browser: "Chrome", pattern: /CriOS\/(\d+)/u },
  { browser: "Firefox", pattern: /FxiOS\/(\d+)/u },
  { browser: "Firefox", pattern: /Firefox\/(\d+)/u },
  { browser: "Chrome", pattern: /Chrome\/(\d+)/u },
  { browser: "Safari", pattern: /Version\/([\d.]+)/u },
];

const PLATFORM_TOKENS: readonly Token[] = [
  { browser: "iOS", pattern: /iPhone|iPad|iPod/u },
  { browser: "Android", pattern: /Android/u },
  { browser: "ChromeOS", pattern: /CrOS/u },
  { browser: "Windows", pattern: /Windows/u },
  { browser: "macOS", pattern: /Mac OS X|Macintosh/u },
  { browser: "Linux", pattern: /Linux|X11/u },
];

const firstMatch = (userAgent: string, tokens: readonly Token[]) => {
  for (const { pattern, browser } of tokens) {
    const match = pattern.exec(userAgent);
    if (match) return `${browser} ${match[1]?.split(".")[0] ?? ""}`.trim();
  }
  return undefined;
};

export function describeUserAgent(userAgent: string): string {
  const trimmed = userAgent.trim();
  if (!trimmed || trimmed === "UNKNOWN") return "Unknown device";
  const browser = firstMatch(trimmed, BROWSER_TOKENS);
  const platform = firstMatch(trimmed, PLATFORM_TOKENS);
  if (browser && platform) return `${browser} on ${platform}`;
  // Nothing matched: the raw header is still more informative than a
  // guess, so show it and let the row's ellipsis keep the layout intact.
  return browser ?? platform ?? trimmed;
}
