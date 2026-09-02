import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const readerBridgeChannel = "feedfathom-reader";
export const readerBridgeVersion = 1;

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
const listFeedsMessageSchema = Type.Object(
  {
    action: Type.Literal("list-feeds"),
    feedsData: Type.Array(
      Type.Object(
        {
          title: Type.String(),
          url: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const visibilityLostMessageSchema = Type.Object(
  { action: Type.Literal("visibility-lost") },
  { additionalProperties: false },
);
const scanRequestMessageSchema = Type.Object(
  { action: Type.Literal("scan-request") },
  { additionalProperties: false },
);
const instanceStorageResultSchema = Type.Object(
  { instance: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

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
export type ListFeedsMessage = Static<typeof listFeedsMessageSchema>;
export type VisibilityLostMessage = Static<typeof visibilityLostMessageSchema>;
export type ScanRequestMessage = Static<typeof scanRequestMessageSchema>;

export const storedInstance = (value: unknown): string | undefined =>
  Value.Check(instanceStorageResultSchema, value) ? value.instance : undefined;

export const isListFeedsMessage = (value: unknown): value is ListFeedsMessage =>
  Value.Check(listFeedsMessageSchema, value);

export const isVisibilityLostMessage = (
  value: unknown,
): value is VisibilityLostMessage =>
  Value.Check(visibilityLostMessageSchema, value);

export const isScanRequestMessage = (
  value: unknown,
): value is ScanRequestMessage => Value.Check(scanRequestMessageSchema, value);

export const isReaderRequest = (value: unknown): value is ReaderRequest =>
  Value.Check(readerRequestSchema, value);

export const isReaderResponse = (value: unknown): value is ReaderResponse =>
  Value.Check(readerResponseSchema, value);

export const isReaderResponseForRequest = (
  value: unknown,
  request: ReaderRequest,
): value is ReaderResponse =>
  Value.Check(readerResponseForRequestSchema(request), value);

export const readerErrorResponse = (
  request: ReaderRequest,
  error: ReaderErrorCode,
): ReaderResponse => ({
  action: request.action,
  channel: readerBridgeChannel,
  error,
  id: request.id,
  ok: false,
  type: "response",
  version: readerBridgeVersion,
});
