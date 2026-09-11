import { articlesDataService } from "#features/feeds/services.ts";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { articleQuery } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import { safeArticleUrl } from "#shared/util/safe-url.ts";
import { extractArticle } from "#features/feeds/extract-article.ts";

export async function getArticleHandler({
  query,
  request,
  user,
}: {
  query: Static<typeof articleQuery>;
  request: Request;
  user: AuthedUser;
}) {
  const decoded = Value.Decode(articleQuery, query);
  const article = await articlesDataService.getUserArticle(
    decoded.article,
    user.id,
  );
  if (!article) return json({}, 404);
  return json({
    ...article,
    content: extractArticle(article.content),
    url: safeArticleUrl(article.url, request.url),
  });
}
