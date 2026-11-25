import type { AppConfig } from "#platform/config.ts";
import { readResponseDiagnostic } from "#platform/http/read-response-diagnostic.ts";
import {
  activationPath,
  passwordResetPath,
} from "#shared/contracts/spa-routes.ts";
import type * as runtime from "#platform/runtime.ts";
import { passwordResetLifetime } from "#shared/contracts/limits.ts";
import { providerRequest } from "./mail-providers.ts";

type MailConfig = Pick<AppConfig, "mailProvider" | "publicOrigin">;

export const mailConfigured = (appConfig: MailConfig) =>
  appConfig.mailProvider !== undefined;

export function sendLater(
  kind: string,
  send: () => Promise<void>,
  onFailure: () => Promise<void> = async () => {},
) {
  void send()
    .catch(async (error: unknown) => {
      console.error(`${kind} email failed to send:`, error);
      await onFailure();
    })
    .catch((error: unknown) => {
      console.error(`${kind} email failure cleanup failed:`, error);
    });
}

export class MailSender {
  constructor(
    private readonly appConfig: MailConfig,
    private readonly fetcher: (typeof runtime)["fetcher"],
  ) {}

  public async sendActivationEmail(email: string, token: string) {
    await this.send(
      email,
      "Activate your FeedFathom account",
      "Please activate your account by clicking this link",
      activationPath(token),
    );
  }

  public async sendPasswordResetEmail(email: string, token: string) {
    await this.send(
      email,
      "Reset your FeedFathom password",
      `Reset your password by clicking this link. It expires in ${passwordResetLifetime.words}, and ignoring this message leaves the account as it is`,
      passwordResetPath(token),
    );
  }

  public async sendAccountExistsEmail(email: string, token: string) {
    await this.send(
      email,
      "This address already has a FeedFathom account",
      `Someone just tried to register this address, but an account already exists here. If that was you, reset the password with this link to sign in. The link expires in ${passwordResetLifetime.words}`,
      passwordResetPath(token),
    );
  }

  private async send(
    email: string,
    subject: string,
    lead: string,
    path: string,
  ) {
    const { mailProvider, publicOrigin } = this.appConfig;
    if (!mailProvider) throw new Error("No outgoing mail provider configured");
    if (!publicOrigin) throw new Error("No public origin to link mail to");
    const link = new URL(path, publicOrigin).href;
    const request = providerRequest(mailProvider, {
      from: { address: `welcome@${publicOrigin.hostname}`, name: "FeedFathom" },
      html: `<p>${lead}: <a href="${link}">${link}</a></p>`,
      subject,
      text: `${lead}: ${link}`,
      to: email,
    });
    const response = await this.fetcher(request.url, {
      body: JSON.stringify(request.body),
      headers: { ...request.headers, "content-type": "application/json" },
      method: "POST",
    });

    if (!response.ok) {
      const diagnostic = await readResponseDiagnostic(response);
      throw new Error(
        `${mailProvider.name} request failed with status ${response.status}${diagnostic ? `: ${diagnostic}` : ""}`,
      );
    }
  }
}
