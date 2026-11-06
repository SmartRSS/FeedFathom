import type { AppConfig } from "#platform/config.ts";
import { readResponseDiagnostic } from "#platform/http/read-response-diagnostic.ts";
import {
  activationPath,
  passwordResetPath,
} from "#shared/contracts/spa-routes.ts";
import { resetLifetime } from "#features/auth/account-tokens.ts";

type MailConfig = Pick<
  AppConfig,
  "MAILJET_API_KEY" | "MAILJET_API_SECRET" | "publicOrigin"
>;

// Activation and password-reset mail need both Mailjet credentials; without
// them the routes behave as if those flows did not exist. loadConfig refuses
// credentials without a public origin to link to.
export const mailConfigured = (appConfig: MailConfig) =>
  Boolean(appConfig.MAILJET_API_KEY && appConfig.MAILJET_API_SECRET);

/**
 * Sends without making the caller wait. Only an address the caller named
 * reaches a send, so waiting on Mailjet, a round trip to another host, would
 * make an account that exists answer hundreds of milliseconds slower than one
 * that does not: an enumeration oracle by stopwatch. For the same reason a
 * failure is logged, never answered. `onFailure` undoes what the mail was
 * for.
 */
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

const mailjetEndpoint = "https://api.mailjet.com/v3.1/send";

export class MailSender {
  constructor(
    private readonly appConfig: MailConfig,
    private readonly fetcher: (
      ...args: Parameters<typeof globalThis.fetch>
    ) => ReturnType<typeof globalThis.fetch> = globalThis.fetch,
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
      `Reset your password by clicking this link. It expires in ${resetLifetime.words}, and ignoring this message leaves the account as it is`,
      passwordResetPath(token),
    );
  }

  // Registering with an address that already holds an active account answers
  // with the same success body as a fresh registration; only this message
  // tells the person what actually happened, and hands them a way in (#810).
  public async sendAccountExistsEmail(email: string, token: string) {
    await this.send(
      email,
      "This address already has a FeedFathom account",
      `Someone just tried to register this address, but an account already exists here. If that was you, reset the password with this link to sign in. The link expires in ${resetLifetime.words}`,
      passwordResetPath(token),
    );
  }

  private async send(
    email: string,
    subject: string,
    lead: string,
    path: string,
  ) {
    const { MAILJET_API_KEY, MAILJET_API_SECRET, publicOrigin } =
      this.appConfig;
    if (!publicOrigin) throw new Error("No public origin to link mail to");
    const link = new URL(path, publicOrigin).href;
    const response = await this.fetcher(mailjetEndpoint, {
      body: JSON.stringify({
        Messages: [
          {
            From: {
              Email: `welcome@${publicOrigin.hostname}`,
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
