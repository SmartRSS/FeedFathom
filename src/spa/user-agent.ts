type Token = { pattern: RegExp; browser: string };

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

export function describeUserAgent(userAgent: string | null): string {
  const trimmed = userAgent?.trim();
  if (!trimmed) return "Unknown device";
  const browser = firstMatch(trimmed, BROWSER_TOKENS);
  const platform = firstMatch(trimmed, PLATFORM_TOKENS);
  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform ?? trimmed;
}
