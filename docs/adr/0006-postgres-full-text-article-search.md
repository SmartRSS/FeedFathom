# 0006 — Article search is Postgres full text over a stored tsvector

- **Status:** accepted
- **Date:** 2026-09-10

## Context

Nothing in the app searched articles (#697). The only route to an article was
to select its source and scroll, which stops working somewhere above a couple
of dozen feeds.

The costs had to be weighed before committing, because a search index is a
schema decision and this runs on someone's home server:

- `articles.content` holds full bodies, so a GIN index over them is not small.
- Title-only indexing is a fraction of that size and answers most "what was
  that article" queries; title plus body is the better search.
- `english` stemming on a feed list that is not English is worse than
  `simple`, and feeds do not reliably declare a language.
- `ARTICLE_STALE_AFTER_DAYS` prunes old articles, so search only ever covers
  the retention window.

## Decision

- **Postgres full text, no search service.** Meilisearch or Typesense would
  give better results and cost every self-hoster another container, against a
  project whose promise is one `docker compose up`. Postgres has to be shown
  inadequate first.
- **Title and body, in a `stored generated` tsvector column** on `articles`,
  title at weight A and body at B, with a GIN index (`articles_search_idx`).
  Generated rather than trigger-maintained, so an edited article is searchable
  by its new text with nothing to reindex.
- **`english` stemming.** It degrades gracefully on other languages, where
  the worst case is that a word matches only its exact form. The regconfig has
  to be spelled out in the expression regardless: without it the expression is
  not immutable and Postgres refuses to store it.
- **`plainto_tsquery` at query time.** Terms are ANDed and operators are not
  offered, which is what a single search box implies.
- **Search does not imply longer retention.** Per the ruling on #761 the same
  pruning lifecycle applies to everything; search indexes what exists.
- **Results are newest-first, not best-first.** The article list pages by a
  keyset cursor over `(published_at, id)` (#689), and a `ts_rank` order has no
  such cursor. Rank ordering would need a cursor over `(rank, id)` before it
  could page.
- **Scope is every subscription.** The article whose feed the reader can no
  longer name is the case that makes search worth having, so subscription
  authorizes the rows, exactly as it does for the Today view. Entering search
  also switches the list to the "all" filter: searching for something already
  read is the ordinary case, and the unread default would answer it with an
  empty list.

## Consequences

- The index grows with the body text of everything inside the retention
  window. A self-hoster who finds it too large has no switch for title-only
  short of a migration.
- HTML in `content` is not stripped first. The default parser classifies tags
  as a token type the `english` configuration does not map, so they fall out
  of the vector; attribute values go with them.
- A stopword-only query ("the") is an empty tsquery and matches nothing.
- Adding the column rewrites `articles` and builds the GIN index, so migration
  0006 takes time and an exclusive lock proportional to the table.
