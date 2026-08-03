ALTER TABLE "user_sources" ADD COLUMN "unread_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE user_sources us
SET unread_count = counts.unread
FROM (
  SELECT us2.id,
    (
      coalesce(count(a.id), 0) -
      coalesce(count(CASE
        WHEN ua.deleted_at IS NOT NULL
        OR (
          ua.read_at IS NOT NULL
          AND (a.updated_at IS NULL OR ua.read_at >= a.updated_at)
        )
        THEN 1
      END), 0)
    )::int AS unread
  FROM user_sources us2
  LEFT JOIN articles a
    ON a.source_id = us2.source_id AND a.last_seen_in_feed_at >= us2.created_at
  LEFT JOIN user_articles ua
    ON ua.user_id = us2.user_id AND ua.article_id = a.id
  GROUP BY us2.id
) counts
WHERE us.id = counts.id;