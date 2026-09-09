-- Per-source snooze (#725) is a per-user, per-source timestamp and nothing
-- else: while paused_until lies in the future the source's items never
-- surface as unread, and expiry is evaluated lazily at read time, so no
-- cleanup pass or scheduled job is involved. Parsing and saving continue
-- unchanged during the pause, and the full backlog waits unread when it ends.
ALTER TABLE "user_sources" ADD COLUMN "paused_until" timestamp with time zone;
