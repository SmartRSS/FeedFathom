import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { emailAddressPolicy } from "#shared/validation/typebox-policy.ts";
import {
  isMintedNewsletterAddress,
  isNewsletterAddress,
  newsletterAddress,
  newsletterMailDomain,
} from "../newsletter-address.ts";

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

describe("isNewsletterAddress", () => {
  test("accepts what newsletterAddress mints, in any case", () => {
    const address = newsletterAddress("Mail.Example");
    expect(isNewsletterAddress(address, "mail.example")).toBe(true);
    expect(isNewsletterAddress(address.toUpperCase(), "mail.example")).toBe(
      true,
    );
  });

  test.each([
    ["another domain", "0123456789abcdef@other.example"],
    ["a subdomain", "0123456789abcdef@sub.mail.example"],
    ["a chosen local part", "editor@mail.example"],
    ["a short local part", "0123456789abcde@mail.example"],
    ["a long local part", "0123456789abcdef0@mail.example"],
    ["a second @", "0123456789abcdef@mail.example@other.example"],
  ])("refuses %s", (_, address) => {
    expect(isNewsletterAddress(address, "mail.example")).toBe(false);
  });
});

describe("isMintedNewsletterAddress", () => {
  test.each([
    ["the SPA's format", "0123456789abcdef@mail.example"],
    ["an older extension's format", `${crypto.randomUUID()}@MAIL.example`],
  ])("accepts %s", (_, address) => {
    expect(isMintedNewsletterAddress(address, "mail.example")).toBe(true);
  });

  test.each([
    ["a domain-validation mailbox", "postmaster@mail.example"],
    ["an undashed UUID", `${"0".repeat(32)}@mail.example`],
    ["a UUID on another domain", `${crypto.randomUUID()}@other.example`],
  ])("refuses %s", (_, address) => {
    expect(isMintedNewsletterAddress(address, "mail.example")).toBe(false);
  });
});

describe("newsletterMailDomain", () => {
  test("is absent while mail is disabled", () => {
    expect(
      newsletterMailDomain({
        MAIL_DOMAIN: "mail.example",
        MAIL_ENABLED: false,
      }),
    ).toBeUndefined();
  });

  test("falls back past a blank MAIL_DOMAIN and drops the port", () => {
    expect(
      newsletterMailDomain({
        FEED_FATHOM_DOMAIN: "localhost:3456",
        MAIL_DOMAIN: " ",
        MAIL_ENABLED: true,
      }),
    ).toBe("localhost");
  });
});
