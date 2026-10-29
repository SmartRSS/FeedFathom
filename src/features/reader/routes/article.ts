import type * as feeds from "#features/feeds/services.ts";
import type { StaticDecode } from "typebox";
import type { articleQuery } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import { safeArticleUrl } from "#shared/util/safe-url.ts";
import { extractArticle } from "#features/feeds/extract-article.ts";

export async function getArticleHandler(
  {
    query: decoded,
    request,
    user,
  }: {
    query: StaticDecode<typeof articleQuery>;
    request: Request;
    user: AuthedUser;
  },
  { articlesDataService }: Pick<typeof feeds, "articlesDataService">,
) {
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
