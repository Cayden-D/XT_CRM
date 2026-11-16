BEGIN;

CREATE TABLE image_shop_hero_custom_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_1688_connections(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, id),
  CONSTRAINT image_shop_hero_custom_templates_name_unique UNIQUE (connection_id, name)
);

INSERT INTO image_shop_hero_custom_templates(connection_id, name, storage_key)
SELECT connection_id, '自定义模板', custom_key FROM image_shop_hero_templates WHERE custom_key IS NOT NULL;

ALTER TABLE image_shop_hero_templates ADD COLUMN active_template_id uuid;

UPDATE image_shop_hero_templates AS shop
SET active_template_id = template.id
FROM image_shop_hero_custom_templates AS template
WHERE shop.connection_id = template.connection_id AND shop.mode = 'custom-v1';

ALTER TABLE image_shop_hero_templates
  DROP COLUMN custom_key,
  ADD CHECK ((mode = 'custom-v1') = (active_template_id IS NOT NULL)),
  ADD FOREIGN KEY (connection_id, active_template_id)
    REFERENCES image_shop_hero_custom_templates(connection_id, id) DEFERRABLE INITIALLY DEFERRED;

COMMIT;
