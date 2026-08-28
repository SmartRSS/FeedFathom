import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { emailAddressPolicy } from "#shared/validation/typebox-policy.ts";
import {
  clickSelectsArticle,
  initialPreviewSelection,
  newsletterAddress,
  websiteValidationMessage,
  withScheme,
} from "../discovery-behavior.ts";

describe("withScheme", () => {
  test("prefixes a bare host", () => {
    expect(withScheme("example.com")).toBe("https://example.com");
  });

  test("leaves an existing scheme alone", () => {
    expect(withScheme("http://example.com")).toBe("http://example.com");
    expect(withScheme("HTTPS://example.com")).toBe("HTTPS://example.com");
    expect(withScheme("feed+json://example.com")).toBe(
      "feed+json://example.com",
    );
  });

  // Newsletter subscriptions are addressed by mail; prefixing one would
  // produce nonsense.
  test("leaves a mail address alone", () => {
    expect(withScheme("me@example.com")).toBe("me@example.com");
  });

  test("trims, and leaves an empty value empty", () => {
    expect(withScheme("  example.com  ")).toBe("https://example.com");
    expect(withScheme("   ")).toBe("");
  });
});

describe("websiteValidationMessage", () => {
  test("accepts http and https", () => {
    expect(websiteValidationMessage("example.com")).toBe("");
    expect(websiteValidationMessage("http://example.com")).toBe("");
  });

  test("rejects a scheme that is not http(s)", () => {
    expect(websiteValidationMessage("ftp://example.com")).not.toBe("");
    expect(websiteValidationMessage("javascript:alert(1)")).not.toBe("");
    expect(websiteValidationMessage("data:text/html,x")).not.toBe("");
  });

  test("rejects a value that is not a URL at all", () => {
    expect(websiteValidationMessage("")).not.toBe("");
    expect(websiteValidationMessage("http://")).not.toBe("");
  });
});

describe("initialPreviewSelection", () => {
  test("lands on the first article", () => {
    expect(initialPreviewSelection(3)).toBe(0);
  });

  test("selects nothing when the feed is empty", () => {
    expect(initialPreviewSelection(0)).toBeUndefined();
  });
});

describe("clickSelectsArticle", () => {
  test("a plain click selects", () => {
    expect(clickSelectsArticle({})).toBe(true);
    expect(
      clickSelectsArticle({
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  // The browser's own gesture for "open this elsewhere" must not be swallowed.
  test("any modifier suppresses selection", () => {
    expect(clickSelectsArticle({ ctrlKey: true })).toBe(false);
    expect(clickSelectsArticle({ metaKey: true })).toBe(false);
    expect(clickSelectsArticle({ shiftKey: true })).toBe(false);
    expect(clickSelectsArticle({ altKey: true })).toBe(false);
  });

  // Regression: an earlier draft used ?? instead of ||, so an explicitly
  // false leading modifier short-circuited and hid a pressed later one.
  test("a pressed modifier still counts behind an explicitly false one", () => {
    expect(clickSelectsArticle({ ctrlKey: false, metaKey: true })).toBe(false);
  });
});

describe("newsletterAddress", () => {
  // The address goes straight into /subscribe, which rejects anything the
  // shared email policy does not accept.
  test("mints an address the subscribe contract accepts", () => {
    const address = newsletterAddress("example.com");
    expect(Value.Check(emailAddressPolicy, address)).toBe(true);
    expect(address.endsWith("@example.com")).toBe(true);
  });

  test("does not repeat itself", () => {
    expect(newsletterAddress("example.com")).not.toBe(
      newsletterAddress("example.com"),
    );
  });
});
