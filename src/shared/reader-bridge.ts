import { hasExactKeys, isOneOf } from "#shared/util/exact-object.ts";

export const readerBridgeChannel = "feedfathom-reader";
export const readerBridgeVersion = 1;

export const readerFetchTimeoutMs = 15_000;
export const readerResponseTimeoutMs = readerFetchTimeoutMs + 5_000;

export const readerMaximumHtmlBytes = 3 * 1024 * 1024;

const requestIdPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const readerActions = ["capabilities", "fetch"] as const;
const readerErrorCodes = [
  "FETCH_FAILED",
  "INVALID_RESPONSE",
  "INVALID_URL",
  "NOT_HTML",
  "PRIVATE_URL",
  "TIMEOUT",
  "TOO_LARGE",
  "UNAUTHORIZED",
  "UNAVAILABLE",
] as const;

type ReaderAction = (typeof readerActions)[number];
export type ReaderErrorCode = (typeof readerErrorCodes)[number];

type ReaderEnvelope<Kind extends "request" | "response"> = {
  channel: typeof readerBridgeChannel;
  id: string;
  type: Kind;
  version: typeof readerBridgeVersion;
};

export type ReaderRequest =
  | (ReaderEnvelope<"request"> & { action: "capabilities" })
  | (ReaderEnvelope<"request"> & { action: "fetch"; url: string });

export type ReaderResponse =
  | (ReaderEnvelope<"response"> & {
      action: "capabilities";
      available: true;
      ok: true;
    })
  | (ReaderEnvelope<"response"> & {
      action: "fetch";
      finalUrl: string;
      html: string;
      ok: true;
    })
  | (ReaderEnvelope<"response"> & {
      action: ReaderAction;
      error: ReaderErrorCode;
      ok: false;
    });

const isEnvelope = (
  value: Record<string, unknown>,
  kind: "request" | "response",
): boolean =>
  value["channel"] === readerBridgeChannel &&
  typeof value["id"] === "string" &&
  requestIdPattern.test(value["id"]) &&
  value["type"] === kind &&
  value["version"] === readerBridgeVersion;

const isCapabilitiesRequest = (value: unknown): value is ReaderRequest =>
  hasExactKeys(value, ["action", "channel", "id", "type", "version"]) &&
  value.action === "capabilities" &&
  isEnvelope(value, "request");

const isFetchRequest = (value: unknown): value is ReaderRequest =>
  hasExactKeys(value, ["action", "channel", "id", "type", "url", "version"]) &&
  value.action === "fetch" &&
  typeof value.url === "string" &&
  isEnvelope(value, "request");

export const isReaderRequest = (value: unknown): value is ReaderRequest =>
  isCapabilitiesRequest(value) || isFetchRequest(value);

const isCapabilitiesResponse = (value: unknown): value is ReaderResponse =>
  hasExactKeys(value, [
    "action",
    "available",
    "channel",
    "id",
    "ok",
    "type",
    "version",
  ]) &&
  value.action === "capabilities" &&
  value.available === true &&
  value.ok === true &&
  isEnvelope(value, "response");

const isFetchResponse = (value: unknown): value is ReaderResponse =>
  hasExactKeys(value, [
    "action",
    "channel",
    "finalUrl",
    "html",
    "id",
    "ok",
    "type",
    "version",
  ]) &&
  value.action === "fetch" &&
  typeof value.finalUrl === "string" &&
  typeof value.html === "string" &&
  value.ok === true &&
  isEnvelope(value, "response");

const isErrorResponse = (value: unknown): value is ReaderResponse =>
  hasExactKeys(value, [
    "action",
    "channel",
    "error",
    "id",
    "ok",
    "type",
    "version",
  ]) &&
  isOneOf(value.action, readerActions) &&
  isOneOf(value.error, readerErrorCodes) &&
  value.ok === false &&
  isEnvelope(value, "response");

export const isReaderResponseForRequest = (
  value: unknown,
  request: ReaderRequest,
): value is ReaderResponse =>
  (isCapabilitiesResponse(value) ||
    isFetchResponse(value) ||
    isErrorResponse(value)) &&
  value.action === request.action &&
  value.id === request.id;

export type ReaderFetchRequest = Extract<ReaderRequest, { action: "fetch" }>;

const envelope = {
  channel: readerBridgeChannel,
  version: readerBridgeVersion,
} as const;

export const readerCapabilitiesRequest = (): ReaderRequest => ({
  ...envelope,
  action: "capabilities",
  id: crypto.randomUUID(),
  type: "request",
});

export const readerFetchRequest = (url: string): ReaderFetchRequest => ({
  ...envelope,
  action: "fetch",
  id: crypto.randomUUID(),
  type: "request",
  url,
});

export const readerCapabilitiesResponse = (
  request: ReaderRequest,
): ReaderResponse => ({
  ...envelope,
  action: "capabilities",
  available: true,
  id: request.id,
  ok: true,
  type: "response",
});

export const readerFetchResponse = (
  request: ReaderFetchRequest,
  finalUrl: string,
  html: string,
): ReaderResponse => ({
  ...envelope,
  action: "fetch",
  finalUrl,
  html,
  id: request.id,
  ok: true,
  type: "response",
});

export const readerErrorResponse = (
  request: ReaderRequest,
  error: ReaderErrorCode,
): ReaderResponse => ({
  ...envelope,
  action: request.action,
  error,
  id: request.id,
  ok: false,
  type: "response",
});
