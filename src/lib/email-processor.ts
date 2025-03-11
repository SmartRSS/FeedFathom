import type { ParsedMail } from "mailparser";

export class EmailProcessor {
  /**
   * Extracts email addresses from the recipient list
   * @param email The parsed email object
   * @returns Array of recipient email addresses
   */
  public extractRecipientAddresses(email: ParsedMail): string[] {
    const recipients = Array.isArray(email.to) ? email.to : [email.to];
    const recipientMails: string[] = [];

    for (const addressObject of recipients) {
      if (Array.isArray(addressObject?.value)) {
        for (const value of addressObject.value) {
          if (value.address) {
            recipientMails.push(value.address);
          }
        }
      }
    }

    return recipientMails;
  }

  /**
   * Gets the content of the email, preferring HTML content
   * @param email The parsed email object
   * @returns The email content as HTML string
   */
  public getEmailContent(email: ParsedMail): string {
    if (typeof email.html === "string") {
      return email.html;
    }

    if (typeof email.textAsHtml === "string") {
      return email.textAsHtml;
    }

    return "No content.";
  }
}
