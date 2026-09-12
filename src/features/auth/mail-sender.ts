import type { AppConfig } from "#platform/config.ts";
import { readResponseDiagnostic } from "#platform/http/read-response-diagnostic.ts";

const mailjetEndpoint = "https://api.mailjet.com/v3.1/send";

export class MailSender {
  constructor(
    private readonly appConfig: AppConfig,
    private readonly fetcher: (
      ...args: Parameters<typeof globalThis.fetch>
    ) => ReturnType<typeof globalThis.fetch> = globalThis.fetch,
  ) {}

  public async sendActivationEmail(email: string, token: string) {
    await this.send(
      email,
      "activation",
      "Activate your FeedFathom account",
      "Please activate your account by clicking this link",
      `/activate/${token}`,
    );
  }

  public async sendPasswordResetEmail(email: string, token: string) {
    await this.send(
      email,
      "password reset",
      "Reset your FeedFathom password",
      "Reset your password by clicking this link. It expires in an hour, and ignoring this message leaves the account as it is",
      `/password-reset/${token}`,
    );
  }

  // Registering with an address that already holds an active account answers
  // with the same success body as a fresh registration; only this message
  // tells the person what actually happened, and hands them a way in (#810).
  public async sendAccountExistsEmail(email: string, token: string) {
    await this.send(
      email,
      "account already exists",
      "This address already has a FeedFathom account",
      "Someone just tried to register this address, but an account already exists here. If that was you, reset the password with this link to sign in. The link expires in an hour",
      `/password-reset/${token}`,
    );
  }

  private async send(
    email: string,
    kind: string,
    subject: string,
    lead: string,
    path: string,
  ) {
    const { MAILJET_API_KEY, MAILJET_API_SECRET } = this.appConfig;
    if (!(MAILJET_API_KEY && MAILJET_API_SECRET)) {
      console.log(`Mailjet is not configured. Cannot send ${kind} email.`);
      return;
    }

    const domain = this.appConfig.FEED_FATHOM_DOMAIN ?? "default-domain.com";
    const protocol = domain.startsWith("localhost") ? "http" : "https";
    const link = `${protocol}://${domain}${path}`;
    const response = await this.fetcher(mailjetEndpoint, {
      body: JSON.stringify({
        Messages: [
          {
            From: {
              Email: `welcome@${domain}`,
              Name: "FeedFathom",
            },
            HTMLPart: `<p>${lead}: <a href="${link}">${link}</a></p>`,
            Subject: subject,
            TextPart: `${lead}: ${link}`,
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
