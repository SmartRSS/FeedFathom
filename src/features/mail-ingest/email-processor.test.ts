import { describe, expect, test } from "bun:test";
import type { ParsedMail } from "mailparser";
import { getEmailContent } from "#features/mail-ingest/email-processor.ts";

const createMockEmail = (overrides: Partial<ParsedMail> = {}): ParsedMail => {
  return {
    attachments: [],
    headerLines: [],
    headers: new Map(),
    html: false,
    textAsHtml: undefined,
    to: undefined,
    ...overrides,
  };
};

describe("email processor", () => {
  describe("getEmailContent", () => {
    test("should prefer HTML content when available", () => {
      const email = createMockEmail({
        html: "<p>HTML content</p>",
        textAsHtml: "<p>Text content</p>",
      });

      const result = getEmailContent(email);
      expect(result).toBe("<p>HTML content</p>");
    });

    test("should fall back to textAsHtml when HTML is not available", () => {
      const email = createMockEmail({
        html: false,
        textAsHtml: "<p>Text content</p>",
      });

      const result = getEmailContent(email);
      expect(result).toBe("<p>Text content</p>");
    });

    test("should reject malformed content projections", () => {
      const email = { ...createMockEmail(), html: true };

      expect(() => getEmailContent(email)).toThrow(
        "Mail parser returned an invalid message projection",
      );
    });

    test("should return default message when no content is available", () => {
      const email = createMockEmail({
        html: false,
        textAsHtml: undefined,
      });

      const result = getEmailContent(email);
      expect(result).toBe("No content.");
    });
  });
});
