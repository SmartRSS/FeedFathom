export const mailRelayPath = "/api/mail";
export const mailRelaySecretHeader = "x-feedfathom-mail-secret";

export type MailRelayRequest = {
  from: string;
  raw: string;
  to: string;
};

export const mailRelayRejectionStatus = 422;
export type MailRelayRejection = { error: string; rejected: true };

export const maxRawEmailMebibytes = 5;
export const maxRawEmailBytes = maxRawEmailMebibytes * 1_024 * 1_024;
export const maxRelayPayloadChars = Math.ceil(maxRawEmailBytes / 3) * 4;
export const base64Pattern = "^[A-Za-z0-9+/]+={0,2}$";
