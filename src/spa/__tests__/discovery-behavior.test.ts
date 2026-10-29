import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { emailAddressPolicy } from "#shared/validation/typebox-policy.ts";
import {
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
