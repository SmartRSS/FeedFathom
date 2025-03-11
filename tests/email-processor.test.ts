import { EmailProcessor } from "../src/lib/email-processor";
import { describe, expect, test } from "bun:test";
import { type AddressObject, type EmailAddress, type ParsedMail } from "mailparser";

const createAddressObject = (value: EmailAddress[] = []): AddressObject => {
  return {
    html: "",
    text: "",
    value,
  };
};

const createEmailAddress = (address: string, name = ""): EmailAddress => {
  return { address, name };
};

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

describe("EmailProcessor", () => {
  const processor = new EmailProcessor();

  describe("extractRecipientAddresses", () => {
    test("should extract single recipient address", () => {
      const email = createMockEmail({
        to: createAddressObject([createEmailAddress("test@example.com")]),
      });

      const result = processor.extractRecipientAddresses(email);
      expect(result).toEqual(["test@example.com"]);
    });

    test("should extract multiple recipient addresses", () => {
      const email = createMockEmail({
        to: createAddressObject([
          createEmailAddress("test1@example.com"),
          createEmailAddress("test2@example.com"),
        ]),
      });

      const result = processor.extractRecipientAddresses(email);
      expect(result).toEqual(["test1@example.com", "test2@example.com"]);
    });

    test("should handle array of recipient objects", () => {
      const email = createMockEmail({
        to: [
          createAddressObject([createEmailAddress("test1@example.com")]),
          createAddressObject([createEmailAddress("test2@example.com")]),
        ],
      });

      const result = processor.extractRecipientAddresses(email);
      expect(result).toEqual(["test1@example.com", "test2@example.com"]);
    });

    test("should handle missing or invalid addresses", () => {
      const email = createMockEmail({
        to: createAddressObject([
          createEmailAddress("invalid1@example.com"),
          createEmailAddress("invalid2@example.com"),
          createEmailAddress("valid@example.com"),
        ]),
      });

      // Mock the address property to be undefined at runtime
      const to = email.to as AddressObject;
      const invalidAddress1 = to.value[0] as Partial<EmailAddress>;
      const invalidAddress2 = to.value[1] as Partial<EmailAddress>;
      invalidAddress1.address = undefined;
      invalidAddress2.address = undefined;

      const result = processor.extractRecipientAddresses(email);
      expect(result).toEqual(["valid@example.com"]);
    });

    test("should handle empty recipient list", () => {
      const email = createMockEmail({
        to: createAddressObject(),
      });

      const result = processor.extractRecipientAddresses(email);
      expect(result).toEqual([]);
    });
  });

  describe("getEmailContent", () => {
    test("should prefer HTML content when available", () => {
      const email = createMockEmail({
        html: "<p>HTML content</p>",
        textAsHtml: "<p>Text content</p>",
      });

      const result = processor.getEmailContent(email);
      expect(result).toBe("<p>HTML content</p>");
    });

    test("should fall back to textAsHtml when HTML is not available", () => {
      const email = createMockEmail({
        html: false,
        textAsHtml: "<p>Text content</p>",
      });

      const result = processor.getEmailContent(email);
      expect(result).toBe("<p>Text content</p>");
    });

    test("should handle non-string HTML content", () => {
      const email = createMockEmail({
        html: true as unknown as string,
        textAsHtml: "<p>Text content</p>",
      });

      const result = processor.getEmailContent(email);
      expect(result).toBe("<p>Text content</p>");
    });

    test("should return default message when no content is available", () => {
      const email = createMockEmail({
        html: false,
        textAsHtml: undefined,
      });

      const result = processor.getEmailContent(email);
      expect(result).toBe("No content.");
    });
  });
});
