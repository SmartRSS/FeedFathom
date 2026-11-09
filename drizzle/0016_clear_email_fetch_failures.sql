-- Email sources were once fetched like feeds, and each fetch failed on the
-- address with "cannot be parsed as a URL". Only arriving mail resets the
-- count, so an address that never got mail stayed marked broken.
UPDATE "sources" SET "recent_failures" = 0, "recent_failure_details" = ''
  WHERE "kind" = 'email' AND "recent_failures" > 0;
