import { Type } from "typebox";
import {
  normalizedEmailAddress,
  normalizedNonblankString,
  normalizedSubscriptionTarget,
  normalizedWebUrl,
  withMatchingChangedPasswords,
  withMatchingPasswords,
} from "../lib/typebox-policy.ts";

const id = Type.Integer({ minimum: 1 });
const maximumRequestIds = 500;
const maxRawEmailCharacters = 5 * 1_024 * 1_024;
const normalizedMailEnvelopeValue = Type.Codec(
  Type.String({ maxLength: 320, minLength: 1, pattern: "\\S" }),
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
export const removeSourceRequest = Type.Object({ removeSourceId: id });
export const subscribeRequest = Type.Object({
  sourceFolder: Type.Union([id, Type.Null()]),
  sourceName: normalizedNonblankString,
  sourceUrl: normalizedSubscriptionTarget,
});

export const loginRequest = Type.Object({
  email: normalizedEmailAddress,
  password: Type.String({ minLength: 1 }),
});
export const registerRequest = withMatchingPasswords(
  Type.Object({
    username: normalizedNonblankString,
    email: normalizedEmailAddress,
    password: Type.String({ minLength: 1 }),
    passwordConfirm: Type.String({ minLength: 1 }),
    "cf-turnstile-response": Type.Optional(
      Type.String({ minLength: 1, pattern: "\\S" }),
    ),
  }),
);
export const activationParams = Type.Object({
  token: normalizedNonblankString,
});
export const incomingMailRequest = Type.Object(
  {
    from: normalizedMailEnvelopeValue,
    raw: Type.String({
      maxLength: maxRawEmailCharacters,
      minLength: 1,
    }),
    to: normalizedMailEnvelopeValue,
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
