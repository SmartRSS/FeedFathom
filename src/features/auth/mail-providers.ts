import type { MailProvider } from "#platform/config.ts";

export type OutgoingMail = {
  from: { address: string; name: string };
  html: string;
  subject: string;
  text: string;
  to: string;
};

export type ProviderRequest = {
  body: unknown;
  headers: Record<string, string>;
  url: string;
};

function namedAddress(from: OutgoingMail["from"]) {
  return `${from.name} <${from.address}>`;
}

export function providerRequest(
  provider: MailProvider,
  mail: OutgoingMail,
): ProviderRequest {
  if (provider.name === "Mailjet")
    return {
      body: {
        Messages: [
          {
            From: { Email: mail.from.address, Name: mail.from.name },
            HTMLPart: mail.html,
            Subject: mail.subject,
            TextPart: mail.text,
            To: [{ Email: mail.to }],
          },
        ],
      },
      headers: {
        authorization: `Basic ${btoa(`${provider.apiKey}:${provider.apiSecret}`)}`,
      },
      url: "https://api.mailjet.com/v3.1/send",
    };
  if (provider.name === "Cloudflare")
    return {
      body: {
        from: mail.from,
        html: mail.html,
        subject: mail.subject,
        text: mail.text,
        to: mail.to,
      },
      headers: { authorization: `Bearer ${provider.apiToken}` },
      url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(provider.accountId)}/email/sending/send`,
    };
  if (provider.name === "Postmark")
    return {
      body: {
        From: namedAddress(mail.from),
        HtmlBody: mail.html,
        MessageStream: "outbound",
        Subject: mail.subject,
        TextBody: mail.text,
        To: mail.to,
      },
      headers: {
        accept: "application/json",
        "x-postmark-server-token": provider.serverToken,
      },
      url: "https://api.postmarkapp.com/email",
    };
  return {
    body: {
      from: namedAddress(mail.from),
      html: mail.html,
      subject: mail.subject,
      text: mail.text,
      to: [mail.to],
    },
    headers: { authorization: `Bearer ${provider.apiKey}` },
    url: "https://api.resend.com/emails",
  };
}
