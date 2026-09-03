import { Type } from "typebox";
import {
  base64Pattern,
  maxRelayPayloadChars,
} from "#shared/contracts/mail-relay.ts";
import {
  normalizedEmailAddress,
  normalizedNonblankString,
  normalizedSubscriptionTarget,
  normalizedWebUrl,
  withMatchingChangedPasswords,
  withMatchingPasswords,
} from "#shared/validation/typebox-policy.ts";

const id = Type.Integer({ minimum: 1 });
const maximumRequestIds = 500;
const mailEnvelopeValue = Type.String({
  maxLength: 320,
  minLength: 1,
  pattern: "\\S",
});
const normalizedMailEnvelopeValue = Type.Codec(mailEnvelopeValue)
  .Decode((value) => value.trim())
  .Encode((value) => value);
// The recipient is looked up against sources.url with an exact match, and the
// addresses minted for newsletters are lowercase, so a sender that echoes the
// address back capitalised would otherwise be reported as unknown.
const normalizedMailRecipient = Type.Codec(mailEnvelopeValue)
  .Decode((value) => value.trim().toLowerCase())
  .Encode((value) => value);
const idQueryTransform = Type.Codec(
  Type.Union([id, Type.String({ pattern: "^[1-9]\\d*$" })]),
)
  .Decode((value) => (typeof value === "number" ? value : Number(value)))
  .Encode((value) => value);

export const articleQuery = Type.Object({
  article: idQueryTransform,
});
export const articlesRequest = Type.Object(
  {
    sources: Type.Array(id, {
      maxItems: maximumRequestIds,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export const createFolderRequest = Type.Object({
  name: normalizedNonblankString,
});
export const findQuery = Type.Object({ link: normalizedWebUrl });
export const previewQuery = Type.Object({ feedUrl: normalizedWebUrl });
export const removeArticlesRequest = Type.Object({
  removedArticleIdList: Type.Array(id, {
    maxItems: maximumRequestIds,
    minItems: 1,
    uniqueItems: true,
  }),
});
export const removeFolderRequest = Type.Object({ removeFolderId: id });
export const updateFolderRequest = Type.Object({
  folderId: id,
  folderName: normalizedNonblankString,
});
export const removeSourceRequest = Type.Object({ removeSourceId: id });
export const subscribeRequest = Type.Object({
  sourceFolder: Type.Union([id, Type.Null()]),
  sourceName: normalizedNonblankString,
  sourceUrl: normalizedSubscriptionTarget,
});
// Deliberately excludes the feed/home URL: `sources` rows are shared and
// deduplicated across every subscriber (see sources_url_unique), so letting
// one user edit them would silently repoint everyone else's subscription.
// Name and folder live on user_sources instead, one row per subscriber, so
// those are safe to edit per-user -- changing where the feed itself points
// means unsubscribing and subscribing to a different URL instead.
export const updateSourceRequest = Type.Object({
  sourceFolder: Type.Union([id, Type.Null()]),
  sourceId: id,
  sourceName: normalizedNonblankString,
});

export const loginRequest = Type.Object({
  email: normalizedEmailAddress,
  password: Type.String({ minLength: 1 }),
});
export const registerRequest = withMatchingPasswords(
  Type.Object({
    "cf-turnstile-response": Type.Optional(
      Type.String({ minLength: 1, pattern: "\\S" }),
    ),
    email: normalizedEmailAddress,
    password: Type.String({ minLength: 1 }),
    passwordConfirm: Type.String({ minLength: 1 }),
    username: normalizedNonblankString,
  }),
);
export const activationParams = Type.Object({
  token: normalizedNonblankString,
});
export const incomingMailRequest = Type.Object(
  {
    from: normalizedMailEnvelopeValue,
    raw: Type.String({
      // Base64 of the MIME bytes, so this ceiling is the inflated one; the
      // route checks the decoded byte length as well.
      maxLength: maxRelayPayloadChars,
      minLength: 1,
      pattern: base64Pattern,
    }),
    to: normalizedMailRecipient,
  },
  { additionalProperties: false },
);

export const passwordRequest = withMatchingChangedPasswords(
  Type.Object({
    oldPassword: Type.String({ minLength: 1 }),
    password1: Type.String({ minLength: 1 }),
    password2: Type.String({ minLength: 1 }),
  }),
);
// Dotted key names ("hub.mode") are the actual WebSub spec query params --
// not something this app invented, so kept verbatim rather than remapped.
export const websubVerificationQuery = Type.Object({
  "hub.challenge": Type.String({ minLength: 1 }),
  "hub.lease_seconds": Type.Optional(Type.String()),
  "hub.mode": Type.String(),
  "hub.topic": Type.String(),
});
export const sourceSortSchema = Type.Union([
  Type.Literal("createdAt"),
  Type.Literal("recentFailures"),
  Type.Literal("lastAttempt"),
  Type.Literal("lastSuccess"),
  Type.Literal("subscriberCount"),
  Type.Literal("url"),
]);
export const adminQuery = Type.Object({
  order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
  sortBy: Type.Optional(sourceSortSchema),
});
export const sourceUrlReplacementRequest = Type.Object({
  newUrl: normalizedWebUrl,
  oldUrl: normalizedWebUrl,
});
export const redirectDeletionRequest = Type.Object({
  oldUrl: normalizedWebUrl,
});
