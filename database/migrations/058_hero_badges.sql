-- The core terms written in large type on the 1688 首图, edited by the shop (add, remove, change).
BEGIN;
ALTER TABLE image_workshop_settings ADD COLUMN hero_badges jsonb NOT NULL DEFAULT '["工厂直供","现货速发","支持定制"]'::jsonb
  CHECK (jsonb_typeof(hero_badges) = 'array' AND jsonb_array_length(hero_badges) <= 6);
COMMENT ON COLUMN image_workshop_settings.hero_badges IS '1688 首图上醒目展示的核心优势（如 工厂直供、现货速发、支持定制），可增删改，最多 6 条';
COMMIT;
