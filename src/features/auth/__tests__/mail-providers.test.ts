import { describe, expect, test } from "bun:test";
import { providerRequest } from "#features/auth/mail-providers.ts";

const mail = {
  from: { address: "welcome@example.test", name: "FeedFathom" },
  html: "<p>Hello</p>",
  subject: "Greetings",
  text: "Hello",
  to: "reader@example.com",
};

describe("providerRequest", () => {
  test("Cloudflare sends to the account's endpoint with a bearer token", () => {
    expect(
      providerRequest(
        { accountId: "account-1", apiToken: "cf-token", name: "Cloudflare" },
        mail,
      ),
    ).toEqual({
      body: {
        from: { address: "welcome@example.test", name: "FeedFathom" },
        html: "<p>Hello</p>",
        subject: "Greetings",
        text: "Hello",
        to: "reader@example.com",
      },
      headers: { authorization: "Bearer cf-token" },
      url: "https://api.cloudflare.com/client/v4/accounts/account-1/email/sending/send",
    });
  });

  test("Postmark names the sender and authenticates with the server token", () => {
    expect(
      providerRequest({ name: "Postmark", serverToken: "pm-token" }, mail),
    ).toEqual({
      body: {
        From: "FeedFathom <welcome@example.test>",
        HtmlBody: "<p>Hello</p>",
        MessageStream: "outbound",
        Subject: "Greetings",
        TextBody: "Hello",
        To: "reader@example.com",
      },
      headers: {
        accept: "application/json",
        "x-postmark-server-token": "pm-token",
      },
      url: "https://api.postmarkapp.com/email",
    });
  });

  test("Resend names the sender and authenticates with a bearer key", () => {
    expect(providerRequest({ apiKey: "re-key", name: "Resend" }, mail)).toEqual(
      {
        body: {
          from: "FeedFathom <welcome@example.test>",
          html: "<p>Hello</p>",
          subject: "Greetings",
          text: "Hello",
          to: ["reader@example.com"],
        },
        headers: { authorization: "Bearer re-key" },
        url: "https://api.resend.com/emails",
      },
    );
  });
});
