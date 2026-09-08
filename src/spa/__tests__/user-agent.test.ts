import { describe, expect, it } from "bun:test";
import { describeUserAgent } from "../user-agent.ts";

describe("describeUserAgent", () => {
  it("names the browser and platform for common desktop browsers", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome 141 on Windows");
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      ),
    ).toBe("Edge 141 on Windows");
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
      ),
    ).toBe("Firefox 132 on Windows");
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
      ),
    ).toBe("Safari 17 on macOS");
    expect(
      describeUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
      ),
    ).toBe("Firefox 132 on Linux");
  });

  it("reads mobile browsers that alias another engine or platform", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari 17 on iOS");
    expect(
      describeUserAgent(
        "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.0.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Chrome 128 on iOS");
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome 128 on Android");
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Samsung Internet 26 on Android");
  });

  it("keeps the platform when only it can be identified", () => {
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0) Wget/1.21")).toBe(
      "Windows",
    );
  });

  it("falls back to the raw header and the unknown label", () => {
    expect(describeUserAgent("SomeBot/1.0 (unlisted client)")).toBe(
      "SomeBot/1.0 (unlisted client)",
    );
    expect(describeUserAgent("")).toBe("Unknown device");
    expect(describeUserAgent("UNKNOWN")).toBe("Unknown device");
    expect(describeUserAgent("   ")).toBe("Unknown device");
  });
});
