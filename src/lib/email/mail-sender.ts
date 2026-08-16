import type { AppConfig } from "../../config.ts";
import { readResponseDiagnostic } from "../read-response-diagnostic.ts";

const mailjetEndpoint = "https://api.mailjet.com/v3.1/send";

export class MailSender {
  constructor(
    private readonly appConfig: AppConfig,
    private readonly fetcher: (
      ...args: Parameters<typeof globalThis.fetch>
    ) => ReturnType<typeof globalThis.fetch> = globalThis.fetch,
  ) {}

  public async sendActivationEmail(email: string, token: string) {
    const { MAILJET_API_KEY, MAILJET_API_SECRET } = this.appConfig;
    if (!(MAILJET_API_KEY && MAILJET_API_SECRET)) {
      console.log("Mailjet is not configured. Cannot send activation email.");
      return;
    }

    const domain = this.appConfig.FEED_FATHOM_DOMAIN ?? "default-domain.com";
    const protocol = domain.startsWith("localhost") ? "http" : "https";
    const activationLink = `${protocol}://${domain}/activate/${token}`;
    const response = await this.fetcher(mailjetEndpoint, {
      body: JSON.stringify({
        Messages: [
          {
            From: {
              Email: `welcome@${domain}`,
              Name: "FeedFathom",
            },
            HTMLPart: `<p>Please activate your account by clicking this link: <a href="${activationLink}">${activationLink}</a></p>`,
            Subject: "Activate your FeedFathom account",
            TextPart: `Please activate your account by clicking this link: ${activationLink}`,
            To: [{ Email: email }],
          },
        ],
      }),
      headers: {
        authorization: `Basic ${btoa(`${MAILJET_API_KEY}:${MAILJET_API_SECRET}`)}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      const diagnostic = await readResponseDiagnostic(response);
      throw new Error(
        `Mailjet request failed with status ${response.status}${diagnostic ? `: ${diagnostic}` : ""}`,
      );
    }
  }
}
