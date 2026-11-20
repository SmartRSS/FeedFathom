import { Type } from "typebox";
import {
  base64Pattern,
  maxRelayPayloadChars,
} from "#shared/contracts/mail-relay.ts";
import { maxEmailAddressLength } from "#shared/validation/address-shape.ts";
import {
  jsonDatePolicy,
  normalizedEmailAddress,
  normalizedNonblankString,
  normalizedSubscriptionTarget,
  normalizedWebUrl,
  withMatchingChangedPasswords,
  withMatchingPasswords,
} from "#shared/validation/typebox-policy.ts";

import { maximumRequestIds } from "./limits.ts";

export const opmlUploadField = "opml";

const id = Type.Integer({ minimum: 1 });
const mailEnvelopeValue = Type.String({
  maxLength: maxEmailAddressLength,
  minLength: 1,
  pattern: "\\S",
});
const normalizedMailEnvelopeValue = Type.Codec(mailEnvelopeValue)
  .Decode((value) => value.trim())
  .Encode((value) => value);
const normalizedMailRecipient = Type.Codec(mailEnvelopeValue)
  .Decode((value) => value.trim().toLowerCase())
  .Encode((value) => value);
const searchTerms = Type.Codec(
  Type.String({ maxLength: 200, minLength: 1, pattern: "\\S" }),
)
  .Decode((value) => value.trim())
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
    cursor: Type.Optional(id),
    filter: Type.Optional(
      Type.Union([
        Type.Literal("unread"),
        Type.Literal("read"),
        Type.Literal("all"),
      ]),
    ),
    folder: Type.Optional(id),
    query: Type.Optional(searchTerms),
    revision: Type.Optional(Type.Literal(true)),
    sources: Type.Array(id, {
      maxItems: maximumRequestIds,
      uniqueItems: true,
    }),
    view: Type.Optional(Type.Union([Type.Literal("today")])),
  },
  { additionalProperties: false },
);
export const createFolderRequest = Type.Object({
  name: normalizedNonblankString,
});
export const findQuery = Type.Object({ link: normalizedWebUrl });
export const previewQuery = Type.Object({ feedUrl: normalizedWebUrl });
export const readArticlesRequest = Type.Object({
  articleIdList: Type.Array(id, {
    maxItems: maximumRequestIds,
    minItems: 1,
    uniqueItems: true,
  }),
  read: Type.Boolean(),
});
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
export const refreshSourceRequest = Type.Object({ sourceId: id });
export const snoozeSourceRequest = Type.Object({
  pausedUntil: Type.Union([jsonDatePolicy, Type.Null()]),
  sourceId: id,
});
export const newsletterAddressRequest = Type.Object({
  address: normalizedMailRecipient,
});
export const subscribeRequest = Type.Object({
  sourceFolder: Type.Union([id, Type.Null()]),
  sourceName: normalizedNonblankString,
  sourceUrl: normalizedSubscriptionTarget,
});
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
export const sessionParams = Type.Object({ id: idQueryTransform });
export const passwordResetRequest = Type.Object({
  email: normalizedEmailAddress,
});
export const passwordResetConfirmRequest = withMatchingChangedPasswords(
  Type.Object({
    password1: Type.String({ minLength: 1 }),
    password2: Type.String({ minLength: 1 }),
    token: normalizedNonblankString,
  }),
);
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
