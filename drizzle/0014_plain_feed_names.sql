-- Folder and subscription names imported from OPML kept one layer of HTML
-- escaping ("Jake&#39;s blog"), because some readers export titles that
-- were already HTML-escaped. The parser now decodes HTML character
-- references once after the XML pass; this gives stored names that same
-- single pass. Only numeric references and the five XML entities plus
-- &nbsp; are decoded here, which covers every reference such exports hold.
-- A reference to an invalid code point becomes U+FFFD rather than failing
-- the deploy. Tags are left alone: "<dialog>" in a name is text.
CREATE FUNCTION pg_temp.decode_html_references(value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  rest text := value;
  decoded text := '';
  reference text;
  code integer;
BEGIN
  LOOP
    reference := (regexp_match(rest, '&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);'))[1];
    EXIT WHEN reference IS NULL;
    -- regexp_match found the leftmost match, so this is the same occurrence.
    decoded := decoded || left(rest, position('&' || reference || ';' IN rest) - 1);
    rest := substr(rest, position('&' || reference || ';' IN rest) + length(reference) + 2);
    IF reference LIKE '#%' THEN
      code := CASE
        WHEN reference ~ '^#[xX]' THEN ('x' || lpad(substr(reference, 3), 8, '0'))::bit(32)::integer
        ELSE substr(reference, 2)::integer
      END;
      decoded := decoded || CASE
        WHEN code BETWEEN 1 AND 1114111 AND code NOT BETWEEN 55296 AND 57343 THEN chr(code)
        ELSE chr(65533)
      END;
    ELSE
      decoded := decoded || CASE reference
        WHEN 'amp' THEN '&'
        WHEN 'lt' THEN '<'
        WHEN 'gt' THEN '>'
        WHEN 'quot' THEN '"'
        WHEN 'apos' THEN ''''
        ELSE chr(160)
      END;
    END IF;
  END LOOP;
  RETURN decoded || rest;
END
$$;--> statement-breakpoint
UPDATE "user_folders" SET "name" = pg_temp.decode_html_references("name")
  WHERE "name" ~ '&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);';--> statement-breakpoint
UPDATE "user_sources" SET "name" = pg_temp.decode_html_references("name")
  WHERE "name" ~ '&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);';--> statement-breakpoint
-- Article authors wrapped in markup. The feed library split such a name as
-- "Name <email>" and dropped its outer angle brackets, which stored
-- "span class='p-author h-card'>Name</span"; feeds that did not go through
-- that split stored the tags whole. Both keep only their text. A tag needs
-- whitespace, "/" or ">" after its name, so "Jane <jane@example.com>" is not
-- one. An author that was nothing but markup is left as it is.
UPDATE "articles" SET "author" = "cleaned"."author"
FROM (
  SELECT "id", btrim(regexp_replace(
    regexp_replace("author", '^[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?>(.*)</[A-Za-z][A-Za-z0-9-]*$', '\2'),
    '</?[A-Za-z][A-Za-z0-9-]*([\s/][^<>]*)?>', '', 'g'
  )) AS "author"
  FROM "articles"
  WHERE "author" ~ '^[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?>.*</[A-Za-z][A-Za-z0-9-]*$'
    OR "author" ~ '</?[A-Za-z][A-Za-z0-9-]*([\s/][^<>]*)?>'
) AS "cleaned"
WHERE "articles"."id" = "cleaned"."id" AND "cleaned"."author" <> '';
