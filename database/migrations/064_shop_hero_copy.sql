BEGIN;

ALTER TABLE image_shop_hero_templates
  ADD COLUMN hero_origin text CHECK (hero_origin IS NULL OR char_length(btrim(hero_origin)) BETWEEN 1 AND 24),
  ADD COLUMN hero_notes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(hero_notes) = 'array' AND jsonb_array_length(hero_notes) <= 2);

COMMIT;
