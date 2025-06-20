import Mailjet from "node-mailjet";
import type { AppConfig } from "../../config.ts";
import { llog } from "../../util/log.ts";

export class MailSender {
  private readonly mailjet?: Mailjet;

  constructor(private readonly appConfig: AppConfig) {
    const { MAILJET_API_KEY, MAILJET_API_SECRET } = this.appConfig;

    if (!(MAILJET_API_KEY && MAILJET_API_SECRET)) {
      llog(
        "Mailjet API key or secret is not set. MailSender will not be initialized.",
      );
      return;
    }

    this.mailjet = new Mailjet({
      apiKey: MAILJET_API_KEY,
      apiSecret: MAILJET_API_SECRET,
    });
  }

  public async sendActivationEmail(email: string, token: string) {
    if (!this.mailjet) {
      llog("Mailjet is not initialized. Cannot send activation email.");
      return;
    }

    const domain = this.appConfig.FEED_FATHOM_DOMAIN ?? "default-domain.com";
    const protocol = domain.startsWith("localhost") ? "http" : "https";
    const activationLink = `${protocol}://${domain}/activate/${token}`;
    llog("Generated activation link.", { activationLink });

    try {
      const result = await this.mailjet
        .post("send", { version: "v3.1" })
        .request({
          Messages: [
            {
              From: {
                Email: `welcome@${domain}`,
                Name: "FeedFathom",
              },
              To: [
                {
                  Email: email,
                },
              ],
              Subject: "Activate your FeedFathom account",
              TextPart: `Please activate your account by clicking this link: ${activationLink}`,
              HTMLPart: `<p>Please activate your account by clicking this link: <a href="${activationLink}">${activationLink}</a></p>`,
            },
          ],
        });
      llog("Mailjet send request successful.", { result });
    } catch (error) {
      llog("Failed to send activation email via Mailjet.", { error });
    }
  }
}
