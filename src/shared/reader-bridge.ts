import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const readerBridgeChannel = "feedfathom-reader";
export const readerBridgeVersion = 1;

// The extension gives up on an article fetch after readerFetchTimeoutMs and
// answers TIMEOUT; the page waits a little longer than that, so a slow fetch
// reaches it as TIMEOUT rather than as a silent UNAVAILABLE.
export const readerFetchTimeoutMs = 15_000;
export const readerResponseTimeoutMs = readerFetchTimeoutMs + 5_000;

// One budget for both ends: the extension refuses a body larger than this
// before transferring it, and the page refuses decoded HTML whose UTF-8 size
// exceeds it before parsing.
export const readerMaximumHtmlBytes = 3 * 1024 * 1024;

const requestIdSchema = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});
const readerActionSchema = Type.Union([
  Type.Literal("capabilities"),
  Type.Literal("fetch"),
]);
const readerErrorCodeSchema = Type.Union([
  Type.Literal("FETCH_FAILED"),
  Type.Literal("INVALID_RESPONSE"),
  Type.Literal("INVALID_URL"),
  Type.Literal("NOT_HTML"),
  Type.Literal("PRIVATE_URL"),
  Type.Literal("TIMEOUT"),
  Type.Literal("TOO_LARGE"),
  Type.Literal("TOO_MANY_REDIRECTS"),
  Type.Literal("UNAUTHORIZED"),
  Type.Literal("UNAVAILABLE"),
]);
const readerRequestSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("capabilities"),
      channel: Type.Literal(readerBridgeChannel),
      id: requestIdSchema,
      type: Type.Literal("request"),
      version: Type.Literal(readerBridgeVersion),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("fetch"),
      channel: Type.Literal(readerBridgeChannel),
      id: requestIdSchema,
      type: Type.Literal("request"),
      url: Type.String(),
      version: Type.Literal(readerBridgeVersion),
    },
    { additionalProperties: false },
  ),
]);
const readerResponseSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("capabilities"),
      available: Type.Literal(true),
      channel: Type.Literal(readerBridgeChannel),
      id: requestIdSchema,
      ok: Type.Literal(true),
      type: Type.Literal("response"),
      version: Type.Literal(readerBridgeVersion),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("fetch"),
      channel: Type.Literal(readerBridgeChannel),
      finalUrl: Type.String(),
      html: Type.String(),
      id: requestIdSchema,
      ok: Type.Literal(true),
      type: Type.Literal("response"),
      version: Type.Literal(readerBridgeVersion),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: readerActionSchema,
      channel: Type.Literal(readerBridgeChannel),
      error: readerErrorCodeSchema,
      id: requestIdSchema,
      ok: Type.Literal(false),
      type: Type.Literal("response"),
      version: Type.Literal(readerBridgeVersion),
    },
    { additionalProperties: false },
  ),
]);
const readerResponseForRequestSchema = (request: ReaderRequest) =>
  Type.Intersect([
    readerResponseSchema,
    Type.Object({
      action: Type.Literal(request.action),
      id: Type.Literal(request.id),
    }),
  ]);

export type ReaderErrorCode = Static<typeof readerErrorCodeSchema>;
export type ReaderRequest = Static<typeof readerRequestSchema>;
export type ReaderResponse = Static<typeof readerResponseSchema>;

export const isReaderRequest = (value: unknown): value is ReaderRequest =>
  Value.Check(readerRequestSchema, value);

export const isReaderResponseForRequest = (
  value: unknown,
  request: ReaderRequest,
): value is ReaderResponse =>
  Value.Check(readerResponseForRequestSchema(request), value);

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
