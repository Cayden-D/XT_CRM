BEGIN;

ALTER TABLE image_shop_hero_custom_templates ADD COLUMN frame_insets jsonb;

COMMENT ON COLUMN image_shop_hero_custom_templates.frame_insets IS
  '自定义首图模板开口的四边相对边距；NULL 使用原有固定上下边框。';

COMMIT;
