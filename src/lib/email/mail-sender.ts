import Mailjet from "node-mailjet";
import type { AppConfig } from "../../config.ts";

export class MailSender {
  private readonly mailjet: Mailjet;

  constructor(private readonly appConfig: AppConfig) {
    this.mailjet = new Mailjet({
      apiKey: this.appConfig.MAILJET_API_KEY,
      apiSecret: this.appConfig.MAILJET_API_SECRET,
    });
  }

  public async sendActivationEmail(email: string, token: string) {
    const protocol = this.appConfig.FEED_FATHOM_DOMAIN.startsWith("localhost")
      ? "http"
      : "https";
    const activationLink = `${protocol}://${this.appConfig.FEED_FATHOM_DOMAIN}/activate/${token}`;

    await this.mailjet.post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: {
            Email: "activation@yourdomain.com", // TODO: Make this configurable
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
  }
}
